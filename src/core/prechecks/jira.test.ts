import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import {
  comment,
  history,
  ISSUE_KEY,
  ISSUE_URL,
  issueJson,
  JIRA_BASE,
  JIRA_EMAIL,
  JIRA_TOKEN,
  JIRA_USERS,
  jiraHandlers,
  STATUSES,
  type JiraFixture,
} from '../../../test/fixtures/msw/jira';
import type { Config } from '../config/schema';
import { resolveSecrets, type Env } from '../config/load';
import type { JiraCursor, Watch } from '../domain/types';
import { fetchWithRetry, HttpError } from '../http/fetchWithRetry';
import { FreeformPrecheck } from './freeform';
import { createPrechecks, precheckFor } from './index';
import { JiraPrecheck } from './jira';
import { createJiraClient } from './jiraClient';
import type { Precheck } from './types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const { me, anna, bob } = JIRA_USERS;
const noSleep = (url: string, init: RequestInit) => fetchWithRetry(url, init, { sleep: async () => {} });

function watch(partial: Partial<Watch> = {}): Watch {
  return {
    id: 1,
    kind: 'jira',
    targetUrl: ISSUE_URL,
    normalizedTarget: `jira:jira.example.com/${ISSUE_KEY}`,
    repository: 'pages',
    title: 'Fix the login page',
    state: 'active',
    instructions: null,
    intervalMs: null,
    model: null,
    initialReview: null,
    mrSourceBranch: null,
    cursor: null,
    nextCheckAt: null,
    checkFailures: 0,
    needsYouReason: null,
    needsYouSince: null,
    needsYouRunId: null,
    resolutionNote: null,
    closedReason: null,
    closedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function cursor(partial: Partial<JiraCursor> = {}): JiraCursor {
  return { lastChangelogId: null, lastCommentId: null, ...partial };
}

const defaultEnv = { JIRA_EMAIL: JIRA_EMAIL, JIRA_TOKEN: JIRA_TOKEN };

function jiraConfig(doneStatusIds?: string[]): Config {
  const config = testConfig({
    jira: { connections: { corp: { emailEnv: 'JIRA_EMAIL' } } },
  });
  if (doneStatusIds !== undefined) config.jira.connections.corp!.doneStatusIds = doneStatusIds;
  return config;
}

function setup(fixture: JiraFixture = {}, opts: { config?: Config; env?: Env } = {}) {
  const calls: string[] = [];
  server.use(...jiraHandlers(fixture, calls));
  const config = opts.config ?? jiraConfig();
  const secrets = resolveSecrets(config, opts.env ?? defaultEnv);
  const clients: string[] = [];
  const precheck = new JiraPrecheck({
    config,
    secrets,
    clientFor: (conn) => {
      clients.push(conn);
      return createJiraClient(config.jira.connections[conn]!, secrets.jira[conn] ?? {}, noSleep);
    },
  });
  return { precheck, calls, clients };
}

const baselineComments = [comment(100, anna, 'Can you look?'), comment(101, me, 'On it')];
const baselineHistories = [history(200, bob, [{ field: 'assignee', toString: 'Me Myself' }])];

describe('JiraPrecheck.check', () => {
  test('first check records cursor and is unchanged', async () => {
    const { precheck, calls, clients } = setup({
      issue: issueJson({
        comments: baselineComments,
        histories: baselineHistories,
      }),
    });
    expect(await precheck.check(watch())).toEqual({
      kind: 'unchanged',
      cursor: cursor({ lastChangelogId: '200', lastCommentId: '101' }),
    });
    expect(clients).toEqual(['corp']);
    expect(calls).toEqual([
      'GET /rest/api/2/myself',
      `GET /rest/api/2/issue/${ISSUE_KEY}?expand=changelog&fields=status%2Ccomment%2Csummary`,
    ]);
  });

  test('first check on an empty issue records null ids', async () => {
    const { precheck } = setup();
    expect(await precheck.check(watch())).toEqual({
      kind: 'unchanged',
      cursor: cursor(),
    });
  });

  test("comment by other after cursor is changed 'new comment by Anna'", async () => {
    const { precheck } = setup({
      issue: issueJson({
        comments: [...baselineComments, comment(102, anna, 'Ping'), comment(103, bob, 'Me too')],
        histories: baselineHistories,
      }),
    });
    expect(
      await precheck.check(
        watch({
          cursor: cursor({ lastChangelogId: '200', lastCommentId: '101' }),
        }),
      ),
    ).toEqual({
      kind: 'changed',
      reason: 'new comment by Anna',
    });
  });

  test('ids are compared numerically', async () => {
    const { precheck } = setup({
      issue: issueJson({
        comments: [comment(99, anna, 'old'), comment(1000, bob, 'new')],
      }),
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastCommentId: '999' }) }))).toEqual({
      kind: 'changed',
      reason: 'new comment by Bob',
    });
  });

  test('a null cursor id treats every entry as new', async () => {
    const { precheck } = setup({
      issue: issueJson({ comments: [comment(5, anna, 'first')] }),
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastChangelogId: '200' }) }))).toEqual({
      kind: 'changed',
      reason: 'new comment by Anna',
    });
  });

  test("changelog entry by other is changed 'status changed to In Review'", async () => {
    const { precheck } = setup({
      issue: issueJson({
        status: STATUSES.inReview,
        comments: baselineComments,
        histories: [
          ...baselineHistories,
          history(201, anna, [
            { field: 'resolution', toString: null },
            { field: 'status', fromString: 'To Do', toString: 'In Review' },
          ]),
        ],
      }),
    });
    expect(
      await precheck.check(
        watch({
          cursor: cursor({ lastChangelogId: '200', lastCommentId: '101' }),
        }),
      ),
    ).toEqual({
      kind: 'changed',
      reason: 'status changed to In Review',
    });
  });

  test('non-status changelog entry is "<field> changed" and causes are joined with "; "', async () => {
    const { precheck } = setup({
      issue: issueJson({
        comments: [...baselineComments, comment(102, bob, 'Ping')],
        histories: [...baselineHistories, history(201, anna, [{ field: 'priority', fromString: 'Low', toString: 'High' }])],
      }),
    });
    expect(
      await precheck.check(
        watch({
          cursor: cursor({ lastChangelogId: '200', lastCommentId: '101' }),
        }),
      ),
    ).toEqual({
      kind: 'changed',
      reason: 'new comment by Bob; priority changed',
    });
  });

  test('own changes ignored', async () => {
    const { precheck } = setup({
      issue: issueJson({
        status: STATUSES.inReview,
        comments: [...baselineComments, comment(102, me, 'Pushed a fix')],
        histories: [...baselineHistories, history(201, me, [{ field: 'status', fromString: 'To Do', toString: 'In Review' }])],
      }),
    });
    expect(
      await precheck.check(
        watch({
          cursor: cursor({ lastChangelogId: '200', lastCommentId: '101' }),
        }),
      ),
    ).toEqual({
      kind: 'unchanged',
    });
  });

  test('done by configured id closes jira-done', async () => {
    const config = jiraConfig(['10005']);
    const closed = setup({ issue: issueJson({ status: STATUSES.closed }) }, { config });
    expect(await closed.precheck.check(watch())).toEqual({
      kind: 'close',
      reason: 'jira-done',
    });
    server.resetHandlers();
    const doneCategory = setup({ issue: issueJson({ status: STATUSES.done }) }, { config });
    expect(await doneCategory.precheck.check(watch())).toEqual({
      kind: 'unchanged',
      cursor: cursor(),
    });
  });

  test('done by category when ids absent', async () => {
    const { precheck } = setup({
      issue: issueJson({
        status: STATUSES.done,
        comments: [...baselineComments, comment(102, anna, 'Closing')],
      }),
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastCommentId: '101' }) }))).toEqual({ kind: 'close', reason: 'jira-done' });
  });

  test('empty id list never closes', async () => {
    const { precheck } = setup({ issue: issueJson({ status: STATUSES.done }) }, { config: jiraConfig([]) });
    expect(await precheck.check(watch({ cursor: cursor() }))).toEqual({
      kind: 'unchanged',
    });
  });

  test('invalid token returns failed auth true', async () => {
    const { precheck, calls } = setup({}, { env: { JIRA_EMAIL, JIRA_TOKEN: 'wrong' } });
    expect(await precheck.check(watch())).toMatchObject({
      kind: 'failed',
      auth: true,
    });
    expect(calls).toEqual(['GET /rest/api/2/myself']);
  });

  test('500 x3 returns failed auth false', async () => {
    const { precheck, calls } = setup({ status: 500 });
    expect(await precheck.check(watch())).toMatchObject({
      kind: 'failed',
      auth: false,
    });
    expect(calls).toHaveLength(3);
  });

  test('caches me per connection across checks', async () => {
    const { precheck, calls } = setup();
    await precheck.check(watch());
    await precheck.check(watch({ cursor: cursor() }));
    expect(calls.filter((c) => c.endsWith('/myself'))).toHaveLength(1);
  });

  test('retries me after a failed lookup', async () => {
    const { precheck } = setup({ status: 503 });
    expect(await precheck.check(watch())).toMatchObject({
      kind: 'failed',
      auth: false,
    });
    server.resetHandlers();
    server.use(...jiraHandlers());
    expect(await precheck.check(watch())).toEqual({
      kind: 'unchanged',
      cursor: cursor(),
    });
  });
});

describe('JiraPrecheck.snapshot', () => {
  test('snapshot returns events since cursor and new cursorCandidate', async () => {
    const { precheck } = setup({
      issue: issueJson({
        status: STATUSES.inReview,
        summary: 'Fix the login page (v2)',
        comments: [
          ...baselineComments,
          comment(103, anna, 'Please also check Safari', {
            created: '2026-10-21T08:05:00.000+0000',
          }),
          comment(104, me, 'Will do'),
        ],
        histories: [
          ...baselineHistories,
          history(
            201,
            bob,
            [
              { field: 'status', fromString: 'To Do', toString: 'In Review' },
              { field: 'assignee', toString: 'Anna' },
            ],
            { created: '2026-10-21T08:00:00.000+0000' },
          ),
          history(202, me, [{ field: 'labels', toString: 'frontend' }]),
        ],
      }),
    });
    const snap = await precheck.snapshot(
      watch({
        cursor: cursor({ lastChangelogId: '200', lastCommentId: '101' }),
      }),
    );
    expect(snap).toEqual({
      title: 'Fix the login page (v2)',
      cursorCandidate: cursor({ lastChangelogId: '202', lastCommentId: '104' }),
      events: [
        {
          at: Date.parse('2026-10-21T08:00:00.000Z'),
          author: 'Bob',
          text: 'status: To Do → In Review; assignee: Anna',
        },
        {
          at: Date.parse('2026-10-21T08:05:00.000Z'),
          author: 'Anna',
          text: 'Please also check Safari',
          url: `${JIRA_BASE}/browse/${ISSUE_KEY}?focusedCommentId=103`,
        },
      ],
    });
  });

  test('snapshot with null cursor has no events and baseline cursorCandidate', async () => {
    const { precheck } = setup({
      issue: issueJson({
        comments: baselineComments,
        histories: baselineHistories,
      }),
    });
    const snap = await precheck.snapshot(watch());
    expect(snap.events).toEqual([]);
    expect(snap.cursorCandidate).toEqual(cursor({ lastChangelogId: '200', lastCommentId: '101' }));
    expect(snap.close).toBeUndefined();
  });

  test('snapshot keeps cursor ids when nothing newer exists', async () => {
    const { precheck } = setup({
      issue: issueJson({ comments: baselineComments }),
    });
    const snap = await precheck.snapshot(
      watch({
        cursor: cursor({ lastChangelogId: '300', lastCommentId: '101' }),
      }),
    );
    expect(snap.cursorCandidate).toEqual(cursor({ lastChangelogId: '300', lastCommentId: '101' }));
  });

  test('snapshot reports close jira-done', async () => {
    const { precheck } = setup({ issue: issueJson({ status: STATUSES.done }) });
    expect((await precheck.snapshot(watch())).close).toBe('jira-done');
  });

  test('snapshot without token returns the stored cursor and title without requests', async () => {
    const { precheck, calls } = setup({}, { env: {} });
    const stored = cursor({ lastCommentId: '7' });
    expect(await precheck.snapshot(watch({ cursor: stored }))).toEqual({
      events: [],
      cursorCandidate: stored,
      title: 'Fix the login page',
    });
    expect(await precheck.snapshot(watch())).toEqual({
      events: [],
      cursorCandidate: {},
      title: 'Fix the login page',
    });
    expect(calls).toEqual([]);
  });

  test('snapshot throws HttpError on failure', async () => {
    const { precheck } = setup({ status: 404 });
    await expect(precheck.snapshot(watch())).rejects.toBeInstanceOf(HttpError);
  });
});

describe('JiraPrecheck.hasToken', () => {
  test('hasToken false when tokenEnv unset', () => {
    const config = jiraConfig();
    delete config.jira.connections.corp!.tokenEnv;
    expect(setup({}, { config }).precheck.hasToken(watch())).toBe(false);
  });

  test('hasToken false when the token variable is empty or missing', () => {
    expect(setup({}, { env: { JIRA_EMAIL } }).precheck.hasToken(watch())).toBe(false);
    expect(setup({}, { env: { JIRA_TOKEN: '' } }).precheck.hasToken(watch())).toBe(false);
  });

  test('hasToken true with a token', () => {
    expect(setup().precheck.hasToken(watch())).toBe(true);
  });
});

describe('createJiraClient', () => {
  test('uses bearer auth when only a token is given', async () => {
    setup();
    const client = createJiraClient({ baseUrl: `${JIRA_BASE}/` }, { token: JIRA_TOKEN }, noSleep);
    expect(await client.myself()).toEqual({ accountId: 'me' });
  });

  test('maps issue fields', async () => {
    setup({
      issue: issueJson({
        status: STATUSES.inReview,
        comments: [comment(100, anna, 'Hi')],
        histories: [history(200, bob, [{ field: 'status', fromString: 'To Do', toString: 'In Review' }])],
      }),
    });
    const client = createJiraClient({ baseUrl: JIRA_BASE }, { email: JIRA_EMAIL, token: JIRA_TOKEN }, noSleep);
    expect(await client.issue(ISSUE_KEY)).toEqual({
      key: ISSUE_KEY,
      summary: 'Fix the login page',
      status: { id: '10002', name: 'In Review', categoryKey: 'indeterminate' },
      comments: [
        {
          id: '100',
          authorId: 'anna-1',
          authorName: 'Anna',
          body: 'Hi',
          created: expect.any(String),
        },
      ],
      changelog: [
        {
          id: '200',
          authorId: 'bob-2',
          authorName: 'Bob',
          created: expect.any(String),
          items: [{ field: 'status', fromString: 'To Do', toString: 'In Review' }],
        },
      ],
    });
  });

  test('lists statuses', async () => {
    setup();
    const client = createJiraClient({ baseUrl: JIRA_BASE }, { token: JIRA_TOKEN }, noSleep);
    expect(await client.statuses()).toEqual(Object.values(STATUSES).map((s) => ({ id: s.id, name: s.name })));
  });

  test('missing token throws auth HttpError', async () => {
    const client = createJiraClient({ baseUrl: JIRA_BASE }, { email: JIRA_EMAIL });
    await expect(client.myself()).rejects.toMatchObject({
      auth: true,
      message: 'Jira token missing',
    });
  });
});

describe('FreeformPrecheck', () => {
  test('freeform check always changed', async () => {
    const precheck: Precheck = new FreeformPrecheck();
    const free = watch({
      kind: 'free',
      targetUrl: 'https://example.com/page',
      title: 'Docs',
    });
    expect(await precheck.check(free)).toEqual({
      kind: 'changed',
      reason: 'interval',
    });
    expect(await precheck.snapshot(free, { reviewUnresolved: false })).toEqual({
      events: [],
      cursorCandidate: {},
      title: 'Docs',
    });
  });
});

describe('createPrechecks', () => {
  test('builds one precheck per watch kind', () => {
    const config = jiraConfig();
    const prechecks = createPrechecks({
      config,
      secrets: resolveSecrets(config, defaultEnv),
    });
    expect(precheckFor(prechecks, 'mr')).toBe(prechecks.mr);
    expect(precheckFor(prechecks, 'jira')).toBeInstanceOf(JiraPrecheck);
    expect(precheckFor(prechecks, 'free')).toBeInstanceOf(FreeformPrecheck);
  });
});
