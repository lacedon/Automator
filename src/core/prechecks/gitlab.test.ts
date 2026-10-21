import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import {
  discussion,
  gitlabHandlers,
  HEAD_SHA,
  mrJson,
  MR_URL,
  note,
  USERS,
  type GitLabFixture,
} from '../../../test/fixtures/msw/gitlab';
import type { Config } from '../config/schema';
import type { MrCursor, Watch } from '../domain/types';
import { fetchWithRetry, HttpError } from '../http/fetchWithRetry';
import { GitLabPrecheck } from './gitlab';
import { createGitLabClient, type GitLabClient } from './gitlabClient';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const { me, anna, bob } = USERS;

function watch(partial: Partial<Watch> = {}): Watch {
  return {
    id: 1,
    kind: 'mr',
    targetUrl: MR_URL,
    normalizedTarget: 'gitlab:gitlab.example.com/team/app!42',
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

function cursor(partial: Partial<MrCursor> = {}): MrCursor {
  return { lastNoteId: 0, handledPipelineId: null, handledConflictSha: null, ...partial };
}

function setup(fixture: GitLabFixture = {}, opts: { config?: Config; token?: string } = {}) {
  const calls: string[] = [];
  server.use(...gitlabHandlers(fixture, calls));
  const noSleep = (url: string, init: RequestInit) => fetchWithRetry(url, init, { sleep: async () => {} });
  const token = 'token' in opts ? opts.token : 'test-token';
  const clients: string[] = [];
  const clientFor = (conn: string): GitLabClient => {
    clients.push(conn);
    return createGitLabClient('https://gitlab.example.com', token, noSleep);
  };
  const cached = new Map<string, Promise<{ id: number; username: string }>>();
  const meCache = {
    get: (conn: string) => {
      if (!cached.has(conn)) cached.set(conn, createGitLabClient('https://gitlab.example.com', token, noSleep).me());
      return cached.get(conn)!;
    },
  };
  const precheck = new GitLabPrecheck({ clientFor, config: opts.config ?? testConfig(), meCache });
  return { precheck, calls, clients };
}

const baselineDiscussions = [
  discussion('d1', [note(10, anna, 'Looks fine')]),
  discussion('d2', [note(11, me, 'Thanks'), note(12, bob, 'changed the description', { system: true })]),
];

describe('GitLabPrecheck.check', () => {
  test('first check baseline-only records max note id and is unchanged', async () => {
    const { precheck } = setup({ discussions: baselineDiscussions });
    expect(await precheck.check(watch())).toEqual({ kind: 'unchanged', cursor: cursor({ lastNoteId: 12 }) });
  });

  test('first check unresolved with unresolved discussion by other is changed', async () => {
    const { precheck } = setup({
      discussions: [...baselineDiscussions, discussion('d3', [note(13, anna, 'Rename this', { resolvable: true })])],
    });
    expect(await precheck.check(watch({ initialReview: 'unresolved' }))).toEqual({
      kind: 'changed',
      reason: 'unresolved discussions',
    });
  });

  test('first check falls back to config initialReview', async () => {
    const config = testConfig({ runs: { initialReview: 'unresolved' } });
    const { precheck } = setup(
      { discussions: [discussion('d3', [note(13, anna, 'Rename this', { resolvable: true })])] },
      { config },
    );
    expect(await precheck.check(watch())).toEqual({ kind: 'changed', reason: 'unresolved discussions' });
  });

  test('first check unresolved ignores resolved and own unresolved discussions', async () => {
    const { precheck } = setup({
      discussions: [
        discussion('d3', [note(13, anna, 'Rename this', { resolvable: true, resolved: true })]),
        discussion('d4', [note(14, me, 'Note to self', { resolvable: true })]),
      ],
    });
    expect(await precheck.check(watch({ initialReview: 'unresolved' }))).toEqual({
      kind: 'unchanged',
      cursor: cursor({ lastNoteId: 14 }),
    });
  });

  test('baseline-only first check ignores unresolved discussions', async () => {
    const { precheck } = setup({ discussions: [discussion('d3', [note(13, anna, 'Rename this', { resolvable: true })])] });
    expect(await precheck.check(watch({ initialReview: 'baseline-only' }))).toEqual({
      kind: 'unchanged',
      cursor: cursor({ lastNoteId: 13 }),
    });
  });

  test("new note by other after cursor is changed with reason 'new comment by @anna'", async () => {
    const { precheck } = setup({
      discussions: [...baselineDiscussions, discussion('d3', [note(14, anna, 'One more thing')]), discussion('d4', [note(15, bob, 'Me too')])],
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12 }) }))).toEqual({
      kind: 'changed',
      reason: 'new comment by @anna',
    });
  });

  test('own notes and system notes are ignored', async () => {
    const { precheck } = setup({
      discussions: [
        ...baselineDiscussions,
        discussion('d3', [note(13, me, 'Pushed a fix')]),
        discussion('d4', [note(14, anna, 'added 1 commit', { system: true })]),
      ],
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12 }) }))).toEqual({ kind: 'unchanged' });
  });

  test("failed pipeline on head sha not yet handled is changed 'pipeline #55210 failed'", async () => {
    const { precheck } = setup({
      mr: mrJson({ head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'failed' } }),
      discussions: baselineDiscussions,
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12, handledPipelineId: 55100 }) }))).toEqual({
      kind: 'changed',
      reason: 'pipeline #55210 failed',
    });
  });

  test('failed pipeline is changed on the first check too', async () => {
    const { precheck } = setup({
      mr: mrJson({ head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'failed' } }),
      discussions: baselineDiscussions,
    });
    expect(await precheck.check(watch())).toEqual({ kind: 'changed', reason: 'pipeline #55210 failed' });
  });

  test('already handled pipeline is unchanged', async () => {
    const { precheck } = setup({
      mr: mrJson({ head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'failed' } }),
      discussions: baselineDiscussions,
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12, handledPipelineId: 55210 }) }))).toEqual({
      kind: 'unchanged',
    });
  });

  test('failed pipeline for an older sha is unchanged', async () => {
    const { precheck } = setup({
      mr: mrJson({ head_pipeline: { id: 55210, sha: 'ffffffff00000000', ref: 'feature/widgets', status: 'failed' } }),
      discussions: baselineDiscussions,
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12 }) }))).toEqual({ kind: 'unchanged' });
  });

  test("conflict on new sha is changed 'merge conflict'", async () => {
    const { precheck } = setup({ mr: mrJson({ detailed_merge_status: 'conflict', has_conflicts: true }), discussions: baselineDiscussions });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12, handledConflictSha: 'old' }) }))).toEqual({
      kind: 'changed',
      reason: 'merge conflict',
    });
  });

  test('same sha already handled is unchanged', async () => {
    const { precheck } = setup({ mr: mrJson({ detailed_merge_status: 'conflict', has_conflicts: true }), discussions: baselineDiscussions });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12, handledConflictSha: HEAD_SHA }) }))).toEqual({
      kind: 'unchanged',
    });
  });

  test('need_rebase is not a conflict', async () => {
    const { precheck } = setup({ mr: mrJson({ detailed_merge_status: 'need_rebase' }), discussions: baselineDiscussions });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12 }) }))).toEqual({ kind: 'unchanged' });
  });

  test('multiple causes are joined with "; "', async () => {
    const { precheck } = setup({
      mr: mrJson({
        detailed_merge_status: 'conflict',
        head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'failed' },
      }),
      discussions: [...baselineDiscussions, discussion('d3', [note(14, bob, 'Ping')])],
    });
    expect(await precheck.check(watch({ cursor: cursor({ lastNoteId: 12 }) }))).toEqual({
      kind: 'changed',
      reason: 'new comment by @bob; pipeline #55210 failed; merge conflict',
    });
  });

  test('merged MR returns close merged; closed returns close mr-closed', async () => {
    const merged = setup({ mr: mrJson({ state: 'merged' }) });
    expect(await merged.precheck.check(watch())).toEqual({ kind: 'close', reason: 'merged' });
    server.resetHandlers();
    const closed = setup({ mr: mrJson({ state: 'closed' }) });
    expect(await closed.precheck.check(watch())).toEqual({ kind: 'close', reason: 'mr-closed' });
  });

  test('401 returns failed auth true', async () => {
    const { precheck, calls } = setup({ status: 401 });
    const result = await precheck.check(watch());
    expect(result).toMatchObject({ kind: 'failed', auth: true });
    expect(calls).toHaveLength(1);
  });

  test('500 x3 returns failed auth false', async () => {
    const { precheck, calls } = setup({ status: 500 });
    const result = await precheck.check(watch());
    expect(result).toMatchObject({ kind: 'failed', auth: false });
    expect(calls).toEqual(['GET /api/v4/user', 'GET /api/v4/user', 'GET /api/v4/user']);
  });

  test('missing token returns failed auth true without requests', async () => {
    const { precheck, calls } = setup({}, { token: undefined });
    expect(await precheck.check(watch())).toEqual({ kind: 'failed', auth: true, message: 'GitLab token missing' });
    expect(calls).toEqual([]);
  });

  test('uses the connection from the target and requests the encoded project path', async () => {
    const { precheck, calls, clients } = setup({ discussions: baselineDiscussions });
    await precheck.check(watch());
    expect(clients).toEqual(['corp']);
    expect(calls).toEqual([
      'GET /api/v4/user',
      'GET /api/v4/projects/team%2Fapp/merge_requests/42',
      'GET /api/v4/projects/team%2Fapp/merge_requests/42/discussions?per_page=100&page=1',
    ]);
  });
});

describe('GitLabPrecheck.snapshot', () => {
  test('snapshot returns events since cursor, cursorCandidate with max note id, head pipeline id when failed, sha when conflicted, title and sourceBranch', async () => {
    const { precheck } = setup({
      mr: mrJson({
        detailed_merge_status: 'conflict',
        head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'failed' },
      }),
      discussions: [
        ...baselineDiscussions,
        discussion('d3', [note(14, anna, 'Please rename', { createdAt: '2026-10-21T08:00:00.000Z' }), note(15, me, 'Done')]),
        discussion('d4', [note(16, bob, 'added 1 commit', { system: true })]),
      ],
    });
    const snap = await precheck.snapshot(watch({ cursor: cursor({ lastNoteId: 12, handledPipelineId: 1, handledConflictSha: 'old' }) }), {
      reviewUnresolved: false,
    });
    expect(snap.title).toBe('Add widgets');
    expect(snap.sourceBranch).toBe('feature/widgets');
    expect(snap.close).toBeUndefined();
    expect(snap.cursorCandidate).toEqual({ lastNoteId: 16, handledPipelineId: 55210, handledConflictSha: HEAD_SHA });
    expect(snap.events).toEqual([
      { at: Date.parse('2026-10-21T08:00:00.000Z'), author: '@anna', text: 'Please rename', url: `${MR_URL}#note_14` },
      { at: expect.any(Number), author: 'gitlab', text: `Pipeline #55210 failed on ${HEAD_SHA.slice(0, 8)}` },
      { at: expect.any(Number), author: 'gitlab', text: 'Merge conflict with target branch' },
    ]);
  });

  test('snapshot keeps previous handled values when nothing failed or conflicted', async () => {
    const { precheck } = setup({ discussions: baselineDiscussions });
    const snap = await precheck.snapshot(watch({ cursor: cursor({ lastNoteId: 12, handledPipelineId: 7, handledConflictSha: 'old' }) }), {
      reviewUnresolved: false,
    });
    expect(snap.events).toEqual([]);
    expect(snap.cursorCandidate).toEqual({ lastNoteId: 12, handledPipelineId: 7, handledConflictSha: 'old' });
  });

  test('snapshot with null cursor baseline-only has no note events but includes pipeline failure', async () => {
    const { precheck } = setup({
      mr: mrJson({ head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'failed' } }),
      discussions: [...baselineDiscussions, discussion('d3', [note(13, anna, 'Rename this', { resolvable: true })])],
    });
    const snap = await precheck.snapshot(watch(), { reviewUnresolved: false });
    expect(snap.events.map((e) => e.text)).toEqual([`Pipeline #55210 failed on ${HEAD_SHA.slice(0, 8)}`]);
    expect(snap.cursorCandidate).toEqual({ lastNoteId: 13, handledPipelineId: 55210, handledConflictSha: null });
  });

  test('snapshot with null cursor in unresolved mode includes unresolved discussions by others', async () => {
    const { precheck } = setup({
      discussions: [...baselineDiscussions, discussion('d3', [note(13, anna, 'Rename this', { resolvable: true })])],
    });
    const snap = await precheck.snapshot(watch({ initialReview: 'unresolved' }), { reviewUnresolved: false });
    expect(snap.events).toEqual([{ at: expect.any(Number), author: '@anna', text: 'Rename this', url: `${MR_URL}#note_13` }]);
  });

  test('snapshot with reviewUnresolved includes unresolved discussions regardless of cursor', async () => {
    const { precheck } = setup({
      discussions: [
        discussion('d1', [note(5, anna, 'Old unresolved', { resolvable: true }), note(6, me, 'Not sure', { resolvable: true })]),
        discussion('d2', [note(7, bob, 'Old resolved', { resolvable: true, resolved: true })]),
        discussion('d3', [note(8, me, 'My own open thread', { resolvable: true })]),
        discussion('d4', [note(20, bob, 'Fresh comment')]),
      ],
    });
    const snap = await precheck.snapshot(watch({ cursor: cursor({ lastNoteId: 12 }) }), { reviewUnresolved: true });
    expect(snap.events.map((e) => [e.author, e.text])).toEqual([
      ['@anna', 'Old unresolved'],
      ['@me', 'Not sure'],
      ['@bob', 'Fresh comment'],
    ]);
    expect((snap.cursorCandidate as MrCursor).lastNoteId).toBe(20);
  });

  test('snapshot reports close for merged MR', async () => {
    const { precheck } = setup({ mr: mrJson({ state: 'merged' }) });
    const snap = await precheck.snapshot(watch(), { reviewUnresolved: false });
    expect(snap.close).toBe('merged');
  });

  test('snapshot throws HttpError on failure', async () => {
    const { precheck } = setup({ status: 403 });
    await expect(precheck.snapshot(watch(), { reviewUnresolved: false })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('createGitLabClient', () => {
  test('paginates discussions via x-next-page', async () => {
    const discussions = Array.from({ length: 5 }, (_, i) => discussion(`d${i}`, [note(i + 1, anna, `n${i}`)]));
    const { calls } = setup({ discussions, pageSize: 2 });
    const client = createGitLabClient('https://gitlab.example.com/', 'test-token', (url, init) =>
      fetchWithRetry(url, init, { sleep: async () => {} }),
    );
    const result = await client.discussions('team%2Fapp', 42);
    expect(result.map((d) => d.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(result[0]).toEqual({
      id: 'd0',
      resolvable: false,
      resolved: false,
      notes: [{ id: 1, system: false, authorId: anna.id, authorUsername: 'anna', body: 'n0', createdAt: expect.any(String) }],
    });
    expect(calls.filter((c) => c.includes('discussions'))).toHaveLength(3);
  });

  test('maps merge request fields', async () => {
    setup({ mr: mrJson({ head_pipeline: null }) });
    const client = createGitLabClient('https://gitlab.example.com', 'test-token');
    expect(await client.mr('team%2Fapp', 42)).toEqual({
      title: 'Add widgets',
      state: 'opened',
      sha: HEAD_SHA,
      sourceBranch: 'feature/widgets',
      detailedMergeStatus: 'mergeable',
      headPipeline: null,
      webUrl: MR_URL,
    });
  });

  test('missing token throws auth HttpError', async () => {
    const client = createGitLabClient('https://gitlab.example.com', undefined);
    await expect(client.me()).rejects.toMatchObject({ auth: true, message: 'GitLab token missing' });
  });
});
