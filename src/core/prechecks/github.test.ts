import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import type { MrCursor, Watch } from '../domain/types';
import { fetchWithRetry } from '../http/fetchWithRetry';
import { GitHubPrecheck } from './github';
import { createGitHubClient } from './githubClient';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API = 'https://api.github.com';
const PR_URL = 'https://github.com/acme/app/pull/7';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const me = { id: 1, login: 'me' };
const anna = { id: 2, login: 'anna' };

type Fixture = {
  pr?: Record<string, unknown>;
  comments?: unknown[];
  reviews?: unknown[];
  checkRuns?: { id: number; conclusion: string | null }[];
  threads?: unknown[];
  replies?: unknown[];
  graphqlError?: { type: string; message: string };
};

function prJson(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Add widgets',
    state: 'open',
    merged: false,
    mergeable_state: 'clean',
    html_url: PR_URL,
    head: { sha: SHA, ref: 'feature/widgets' },
    ...overrides,
  };
}

const at = (id: number) => new Date(Date.parse('2026-10-20T09:00:00Z') + id * 60_000).toISOString();
// Mirrors the client's shared ordering key (creation time in seconds, then GitHub ID).
const key = (id: number) => Math.floor(Date.parse(at(id)) / 1000) * 1_000_000 + id;

function comment(id: number, user: typeof me, body: string) {
  return {
    id,
    user,
    body,
    created_at: at(id),
    html_url: `${PR_URL}#issuecomment-${id}`,
  };
}

function thread(id: string, resolved: boolean, commentId: number, author: typeof me, more = false) {
  return {
    id,
    isResolved: resolved,
    comments: {
      pageInfo: { hasNextPage: more, endCursor: more ? 'c1' : null },
      nodes: [
        {
          databaseId: commentId,
          author: { login: author.login, databaseId: author.id },
          body: 'Rename this',
          createdAt: at(commentId),
          url: `${PR_URL}#discussion_r${commentId}`,
        },
      ],
    },
  };
}

function setup(fixture: Fixture = {}) {
  const calls: string[] = [];
  const auth = (request: Request) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return request.headers.get('authorization') === 'Bearer test-token'
      ? null
      : HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
  };
  server.use(
    http.get(`${API}/user`, ({ request }) => auth(request) ?? HttpResponse.json(me)),
    http.get(
      `${API}/repos/acme/app/pulls/7`,
      ({ request }) => auth(request) ?? HttpResponse.json(fixture.pr ?? prJson()),
    ),
    http.get(
      `${API}/repos/acme/app/commits/${SHA}/check-runs`,
      ({ request }) => auth(request) ?? HttpResponse.json({ check_runs: fixture.checkRuns ?? [] }),
    ),
    http.get(`${API}/repos/acme/app/issues/7/comments`, ({ request }) => {
      const all = (fixture.comments ?? []) as unknown[];
      const page = Number(new URL(request.url).searchParams.get('page') ?? 1);
      const next =
        page === 1 && all.length > 1 ? `<${API}/repos/acme/app/issues/7/comments?per_page=100&page=2>; rel="next"` : '';
      const slice = all.length > 1 ? (page === 1 ? all.slice(0, 1) : all.slice(1)) : all;
      return auth(request) ?? HttpResponse.json(slice, { headers: next ? { link: next } : {} });
    }),
    http.get(
      `${API}/repos/acme/app/pulls/7/reviews`,
      ({ request }) => auth(request) ?? HttpResponse.json(fixture.reviews ?? []),
    ),
    http.post(`${API}/graphql`, async ({ request }) => {
      const failure = auth(request);
      if (failure) return failure;
      if (fixture.graphqlError) return HttpResponse.json({ errors: [fixture.graphqlError] });
      const body = (await request.json()) as { query: string };
      if (body.query.includes('node(id')) {
        return HttpResponse.json({
          data: {
            node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fixture.replies ?? [] } },
          },
        });
      }
      return HttpResponse.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: fixture.threads ?? [],
              },
            },
          },
        },
      });
    }),
  );
  const noSleep = (url: string, init: RequestInit) => fetchWithRetry(url, init, { sleep: async () => {} });
  const client = () => createGitHubClient('github.com', 'test-token', noSleep);
  const config = testConfig({ github: { gh: { host: 'github.com', tokenEnv: 'GITHUB_TOKEN' } } });
  const precheck = new GitHubPrecheck({
    config,
    clientFor: client,
    meCache: { get: async () => ({ id: me.id, username: me.login }) },
  });
  return { client: client(), precheck, calls };
}

function watch(partial: Partial<Watch> = {}): Watch {
  return {
    id: 1,
    kind: 'mr',
    targetUrl: PR_URL,
    normalizedTarget: 'github:github.com/acme/app#7',
    repository: 'pages',
    title: 'Add widgets',
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

const cursor = (partial: Partial<MrCursor> = {}): MrCursor => ({
  lastNoteId: 0,
  handledPipelineId: null,
  handledConflictSha: null,
  ...partial,
});

describe('createGitHubClient', () => {
  test('maps a pull request and failed check runs', async () => {
    const { client } = setup({
      pr: prJson({ mergeable_state: 'dirty' }),
      checkRuns: [
        { id: 5, conclusion: 'success' },
        { id: 9, conclusion: 'failure' },
        { id: 8, conclusion: null },
      ],
    });
    expect(await client.me()).toEqual({ id: 1, username: 'me' });
    expect(await client.mr('acme/app', 7)).toEqual({
      title: 'Add widgets',
      state: 'opened',
      sha: SHA,
      sourceBranch: 'feature/widgets',
      detailedMergeStatus: 'conflict',
      headPipeline: { id: 9, status: 'failed', sha: SHA },
      webUrl: PR_URL,
    });
  });

  test('reports merged and closed states', async () => {
    const merged = setup({ pr: prJson({ state: 'closed', merged: true }) });
    expect((await merged.client.mr('acme/app', 7)).state).toBe('merged');
    const closed = setup({ pr: prJson({ state: 'closed' }) });
    expect((await closed.client.mr('acme/app', 7)).state).toBe('closed');
  });

  test('combines paginated comments, review bodies and review threads', async () => {
    const { client } = setup({
      comments: [comment(10, anna, 'one'), comment(11, anna, 'two')],
      reviews: [
        { id: 20, user: anna, body: 'Please fix', state: 'CHANGES_REQUESTED', submitted_at: at(20), html_url: 'u' },
        { id: 21, user: anna, body: '', state: 'APPROVED', submitted_at: at(21), html_url: 'u' },
      ],
      threads: [thread('t1', false, 30, anna)],
    });
    const discussions = await client.discussions('acme/app', 7);
    expect(discussions.flatMap((d) => d.notes.map((n) => n.id))).toEqual([10, 11, 20, 30].map(key));
    expect(discussions.find((d) => d.id === 't1')).toMatchObject({ resolvable: true, resolved: false });
  });

  test('fetches further comments of a long review thread', async () => {
    const { client } = setup({
      threads: [thread('t1', false, 30, anna, true)],
      replies: [
        {
          databaseId: 31,
          author: { login: 'anna', databaseId: 2 },
          body: 'late reply',
          createdAt: at(31),
          url: 'u',
        },
      ],
    });
    const [t] = await client.discussions('acme/app', 7);
    expect(t!.notes.map((n) => n.id)).toEqual([30, 31].map(key));
  });

  test('GraphQL permission errors are auth failures, other errors are not', async () => {
    const forbidden = setup({ graphqlError: { type: 'FORBIDDEN', message: 'Resource not accessible' } });
    await expect(forbidden.client.discussions('acme/app', 7)).rejects.toMatchObject({ auth: true });
    const other = setup({ graphqlError: { type: 'INTERNAL', message: 'oops' } });
    await expect(other.client.discussions('acme/app', 7)).rejects.toMatchObject({ auth: false });
  });

  test('missing token is an auth failure', async () => {
    setup();
    await expect(createGitHubClient('github.com', undefined).me()).rejects.toMatchObject({ auth: true });
  });
});

describe('GitHubPrecheck', () => {
  test('comments of different kinds are ordered by time, not by their separate GitHub ID sequences', async () => {
    const { precheck } = setup({
      comments: [comment(10, anna, 'issue comment')],
      threads: [thread('t1', false, 3, anna)],
    });
    // The thread comment has a smaller GitHub ID but is newer than the cursor's note.
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: key(2) }) }))).toEqual({
      kind: 'changed',
      reason: 'new comment by @anna',
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: key(10) }) }))).toEqual({ kind: 'unchanged' });
  });

  test('first check records the baseline', async () => {
    const { precheck } = setup({ comments: [comment(10, anna, 'hi')] });
    expect(await precheck.check(watch())).toEqual({ kind: 'unchanged', cursor: cursor({ lastNoteId: key(10) }) });
  });

  test('new comment by someone else is a change; own comments are ignored', async () => {
    const { precheck } = setup({ comments: [comment(10, anna, 'hi'), comment(11, me, 'mine')] });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: key(9) }) }))).toEqual({
      kind: 'changed',
      reason: 'new comment by @anna',
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: key(10) }) }))).toEqual({ kind: 'unchanged' });
  });

  test('failed check run and merge conflict are reported once', async () => {
    const { precheck } = setup({
      pr: prJson({ mergeable_state: 'dirty' }),
      checkRuns: [{ id: 9, conclusion: 'failure' }],
    });
    expect(await precheck.check(watch({ cursor: cursor() }))).toEqual({
      kind: 'changed',
      reason: 'check run #9 failed; merge conflict',
    });
    expect(await precheck.check(watch({ cursor: cursor({ handledPipelineId: 9, handledConflictSha: SHA }) }))).toEqual({
      kind: 'unchanged',
    });
  });

  test('unresolved review threads count on a first check with initialReview unresolved', async () => {
    const { precheck } = setup({ threads: [thread('t1', false, 30, anna)] });
    expect(await precheck.check(watch({ initialReview: 'unresolved' }))).toEqual({
      kind: 'changed',
      reason: 'unresolved discussions',
    });
  });

  test('merged pull request closes the watch', async () => {
    const { precheck } = setup({ pr: prJson({ state: 'closed', merged: true }) });
    expect(await precheck.check(watch())).toEqual({ kind: 'close', reason: 'merged' });
  });

  test('snapshot lists events with GitHub links', async () => {
    const { precheck } = setup({
      comments: [comment(10, anna, 'hi')],
      checkRuns: [{ id: 9, conclusion: 'failure' }],
    });
    const snap = await precheck.snapshot(watch({ cursor: cursor({ lastNoteId: key(5) }) }), {
      reviewUnresolved: false,
    });
    expect(snap.sourceBranch).toBe('feature/widgets');
    expect(snap.events.map((e) => [e.author, e.url ?? e.text])).toEqual([
      ['@anna', `${PR_URL}#issuecomment-10`],
      ['github', `Check run #9 failed on ${SHA.slice(0, 8)}`],
    ]);
    expect(snap.cursorCandidate).toEqual(cursor({ lastNoteId: key(10), handledPipelineId: 9 }));
  });

  test('bad credentials are an auth failure', async () => {
    setup();
    const config = testConfig({ github: { gh: { host: 'github.com', tokenEnv: 'GITHUB_TOKEN' } } });
    const precheck = new GitHubPrecheck({
      config,
      clientFor: () =>
        createGitHubClient('github.com', 'wrong', (u, i) => fetchWithRetry(u, i, { sleep: async () => {} })),
      meCache: { get: async () => ({ id: 1, username: 'me' }) },
    });
    expect(await precheck.check(watch())).toMatchObject({ kind: 'failed', auth: true });
  });
});
