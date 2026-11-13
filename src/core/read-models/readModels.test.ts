import fs from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig, type DeepPartial } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toRun, toWatch } from '../db/rows';
import type { Run, Watch } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { createReadModels } from './index';
import { nextCheckText } from './nextCheck';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MIN = 60_000;
const DAY = 86_400_000;

function setup(overrides: DeepPartial<Config> = {}) {
  const config = testConfig(overrides);
  const clock = fakeClock();
  const { db, cleanup } = tempDb();
  const dataDir = new DataDir(config.dataDir);
  const repositories = testRepositories(db, config);
  cleanups.push(() => {
    cleanup();
    fs.rmSync(config.configDir, { recursive: true, force: true });
  });
  return {
    config,
    clock,
    db,
    dataDir,
    repositories,
    read: createReadModels({ db, config, clock, dataDir, repositories }),
  };
}

function setWatch(db: Database, id: number, cols: Record<string, unknown>): void {
  const sets = Object.keys(cols).map((k) => `${k} = @${k}`);
  db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = @id`).run({ ...cols, id });
}

function insertRun(db: Database, cols: Record<string, unknown> = {}): number {
  const row = {
    watch_id: null,
    repository: 'pages',
    status: 'finished',
    trigger: 'schedule',
    priority: 1,
    reason: 'tick',
    model: 'm',
    queued_at: Date.parse('2026-10-21T09:00:00'),
    ...cols,
  };
  const keys = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO runs (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
    .run(row);
  return Number(info.lastInsertRowid);
}

const getWatch = (db: Database, id: number): Watch => toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));
const getRun = (db: Database, id: number): Run => toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));

describe('read models', () => {
  test('home lists needs-you cards newest first with reason', () => {
    const { db, read } = setup();
    const older = insertWatch(db, { state: 'needs_you', title: 'Older' });
    const newer = insertWatch(db, { state: 'needs_you', title: 'Newer' });
    insertWatch(db, { state: 'active' });
    setWatch(db, older, { needs_you_reason: 'pipeline failed', needs_you_since: 1_000 });
    setWatch(db, newer, { needs_you_reason: 'Copilot asked for help', needs_you_since: 2_000 });

    const home = read.homeView();

    expect(home.needsYou.map((c) => [c.title, c.reason, c.since])).toEqual([
      ['Newer', 'Copilot asked for help', 2_000],
      ['Older', 'pipeline failed', 1_000],
    ]);
    expect(home.running).toEqual([]);
  });

  test('home shows the running Run and recent finished Runs newest first', () => {
    const { db, read } = setup();
    const w = insertWatch(db, { title: 'Fix login' });
    insertRun(db, { watch_id: w, outcome: 'acted', result_status: 'success', summary: 'replied' });
    insertRun(db, { watch_id: w, outcome: 'nothing', result_status: 'success' });
    const running = insertRun(db, { watch_id: w, status: 'running', started_at: 5_000 });

    const home = read.homeView();

    expect(home.running[0]).toMatchObject({ runId: running, watchId: w, watchTitle: 'Fix login', startedAt: 5_000 });
    expect(home.recent.map((r) => r.outcome)).toEqual(['nothing', 'acted']);
  });

  test('watch list pins needs_you first and closed last, counts per state', () => {
    const { db, read } = setup();
    insertWatch(db, { state: 'closed', title: 'A closed' });
    insertWatch(db, { state: 'paused', title: 'B paused' });
    insertWatch(db, { state: 'active', title: 'D active' });
    insertWatch(db, { state: 'active', title: 'C active' });
    insertWatch(db, { state: 'needs_you', title: 'Z needs' });

    const list = read.watchList({});

    expect(list.rows.map((r) => r.title)).toEqual(['Z needs', 'C active', 'D active', 'B paused', 'A closed']);
    expect(list.counts).toEqual({ all: 5, needs_you: 1, active: 2, paused: 1, closed: 1 });
    expect(read.watchList({ state: 'active' }).rows.map((r) => r.title)).toEqual(['C active', 'D active']);
    expect(read.watchList({ q: 'paus' }).rows.map((r) => r.title)).toEqual(['B paused']);
  });

  test('a named Automation shows its name on the board, Home and Run lists; unnamed ones keep their title', () => {
    const { db, read } = setup();
    const named = insertWatch(db, { title: 'Original title', state: 'needs_you' });
    insertWatch(db, { title: 'Plain title' });
    setWatch(db, named, { name: 'My name' });

    expect(read.watchList({}).rows.map((r) => r.title)).toEqual(['My name', 'Plain title']);
    expect(read.watchList({ q: 'my na' }).rows.map((r) => r.title)).toEqual(['My name']);
    expect(read.watchList({ q: 'original' }).rows.map((r) => r.title)).toEqual(['My name']);
    expect(read.homeView().needsYou.map((c) => c.title)).toEqual(['My name']);

    setWatch(db, named, { name: null });
    expect(read.watchList({}).rows.map((r) => r.title)).toEqual(['Original title', 'Plain title']);
  });

  test('watch rows include the last finished Run', () => {
    const { db, read } = setup();
    const w = insertWatch(db);
    insertRun(db, { watch_id: w, outcome: 'nothing', result_status: 'success', ended_at: 1 });
    const last = insertRun(db, { watch_id: w, result_status: 'error', interrupted: 'timeout', ended_at: 2 });

    expect(read.watchList({}).rows[0]!.lastRun).toEqual({
      id: last,
      outcome: null,
      resultStatus: 'error',
      interrupted: 'timeout',
      endedAt: 2,
    });
  });

  test('jira notice only when jira disabled and a jira watch exists', () => {
    const disabled = setup();
    insertWatch(disabled.db, { kind: 'mr' });
    expect(disabled.read.watchList({}).jiraNotice).toBe(false);
    const jira = insertWatch(disabled.db, { kind: 'jira', normalizedTarget: 'jira:jira.example.com/ABC-1' });
    expect(disabled.read.watchList({}).jiraNotice).toBe(true);
    setWatch(disabled.db, jira, { state: 'closed' });
    expect(disabled.read.watchList({}).jiraNotice).toBe(false);

    const enabled = setup({ jira: { enabled: true } });
    insertWatch(enabled.db, { kind: 'jira', normalizedTarget: 'jira:jira.example.com/ABC-2' });
    expect(enabled.read.watchList({}).jiraNotice).toBe(false);
  });

  test('nextCheckText covers every kind', () => {
    const { db, config } = setup();
    const now = Date.parse('2026-10-21T10:00:00');
    const id = insertWatch(db, { kind: 'mr' });
    const jiraId = insertWatch(db, { kind: 'jira', normalizedTarget: 'jira:jira.example.com/ABC-1' });
    const base = getWatch(db, id);
    const ctx = { now, running: null, queuedPos: null, config };
    const running = getRun(db, insertRun(db, { watch_id: id, status: 'running', started_at: now - 2 * MIN }));

    expect(nextCheckText({ ...base, nextCheckAt: now + 9 * MIN + 30_000 }, ctx)).toEqual({ kind: 'in', text: 'in 9m' });
    expect(nextCheckText({ ...base, nextCheckAt: now + 2 * 3_600_000 }, ctx).text).toBe('in 2h');
    expect(nextCheckText({ ...base, nextCheckAt: now + 20_000 }, ctx).text).toBe('in <1m');
    expect(nextCheckText(base, { ...ctx, running })).toEqual({
      kind: 'running',
      text: 'running',
      since: now - 2 * MIN,
    });
    expect(nextCheckText(base, { ...ctx, queuedPos: 2 })).toEqual({ kind: 'queued', text: 'queued #2' });
    const friday = Date.parse('2026-10-23T18:55:00');
    expect(nextCheckText({ ...base, nextCheckAt: friday + 9 * MIN }, { ...ctx, now: friday })).toEqual({
      kind: 'after-hours',
      text: 'after hours · Mon 08:00',
    });
    expect(nextCheckText({ ...base, state: 'needs_you' }, ctx)).toEqual({ kind: 'stopped', text: 'stopped' });
    expect(nextCheckText({ ...getWatch(db, jiraId), nextCheckAt: now }, ctx)).toEqual({
      kind: 'jira-off',
      text: 'Jira off',
    });
    expect(nextCheckText({ ...base, state: 'closed', closedAt: now - 18 * DAY - 1 }, ctx)).toEqual({
      kind: 'cleanup',
      text: 'cleanup in 12d',
    });
    expect(nextCheckText({ ...base, state: 'paused' }, ctx)).toEqual({ kind: 'paused', text: 'paused' });
    const noCleanup = { ...config, cleanup: { ...config.cleanup, enabled: false } };
    expect(nextCheckText({ ...base, state: 'closed', closedAt: now }, { ...ctx, config: noCleanup })).toEqual({
      kind: 'closed',
      text: 'closed',
    });
  });

  test('detail hides delete while running', () => {
    const { db, read, config } = setup();
    const w = insertWatch(db, { state: 'active' });
    expect(read.watchDetail(w)!.actions).toContain('delete');

    const runId = insertRun(db, { watch_id: w, status: 'running', started_at: 1 });
    const detail = read.watchDetail(w)!;

    expect(detail.actions).toEqual(['pause', 'close', 'runNow']);
    expect(detail.running?.runId).toBe(runId);
    expect(detail.runs.map((r) => r.id)).toEqual([runId]);
    expect(detail.settings).toMatchObject({
      repository: 'pages',
      folder: config.repositories.pages!.folder,
      intervalMs: 15 * MIN,
      intervalIsDefault: true,
      model: config.runs.defaultModel,
      modelIsDefault: true,
      initialReview: 'baseline-only',
    });
    expect(read.watchDetail(9_999)).toBeNull();
  });

  test('detail shows last handled point and the latest needs-you event', () => {
    const { db, read } = setup();
    const w = insertWatch(db, { state: 'needs_you' });
    setWatch(db, w, {
      cursor_json: JSON.stringify({ lastNoteId: 41, handledPipelineId: 55210, handledConflictSha: null }),
    });
    db.prepare(
      `INSERT INTO needs_you_events (watch_id, reason, created_at, teams_status, teams_error)
       VALUES (?, 'old', 1, 'sent', NULL), (?, 'new', 2, 'failed', 'boom')`,
    ).run(w, w);

    const detail = read.watchDetail(w)!;

    expect(detail.lastHandled).toEqual(['Last comment: note #41', 'Pipeline: #55210', 'Conflicts: none']);
    expect(detail.needsYouEvent).toMatchObject({ reason: 'new', teamsStatus: 'failed', teamsError: 'boom' });
  });

  test('queue view orders by priority then time and shows positions', () => {
    const { db, read } = setup();
    const w1 = insertWatch(db, { title: 'Scheduled early' });
    const w2 = insertWatch(db, { title: 'Manual late' });
    const s = insertRun(db, {
      watch_id: w1,
      status: 'queued',
      priority: 1,
      queued_at: 100,
      reason: 'new comment by @anna',
    });
    const m = insertRun(db, { watch_id: w2, status: 'queued', priority: 0, trigger: 'manual', queued_at: 300 });
    const a = insertRun(db, { status: 'queued', priority: 0, trigger: 'adhoc', queued_at: 200, adhoc_prompt: 'do it' });

    const queue = read.queueView();

    expect(queue.running).toEqual([]);
    expect(queue.waiting.map((r) => [r.position, r.runId])).toEqual([
      [1, a],
      [2, m],
      [3, s],
    ]);
    expect(queue.waiting[0]).toMatchObject({ adhocPrompt: 'do it', watchTitle: null, trigger: 'adhoc' });
    expect(queue.waiting[2]).toMatchObject({ watchTitle: 'Scheduled early', reason: 'new comment by @anna' });
    expect(read.watchList({}).rows.find((r) => r.id === w1)!.nextCheck).toEqual({ kind: 'queued', text: 'queued #3' });
    expect(read.navCounts()).toEqual({ watches: 2, queued: 3 });
  });

  test('run list error filter matches result_status error', () => {
    const { db, read } = setup();
    const w = insertWatch(db);
    insertRun(db, { watch_id: w, result_status: 'success', outcome: 'acted' });
    const failed = insertRun(db, { watch_id: w, result_status: 'error', interrupted: 'cancelled' });
    const failed2 = insertRun(db, { result_status: 'error', trigger: 'adhoc', priority: 0, adhoc_prompt: 'x' });
    insertRun(db, { watch_id: w, status: 'queued' });

    expect(failed).toBeGreaterThan(0);
    expect(read.runList({ outcome: 'error' }).map((r) => r.id)).toEqual([failed2]);
    expect(read.runList({ outcome: 'error', trigger: 'adhoc' }).map((r) => r.id)).toEqual([failed2]);
    expect(read.runList({ outcome: 'acted' })).toHaveLength(0);
    expect(read.runList({})).toHaveLength(1);
  });

  test('run list joins follow-up Runs into one chat and hides Automation Runs', () => {
    const { db, read } = setup();
    const watch = insertWatch(db);
    insertRun(db, { watch_id: watch });
    const first = insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'first question', outcome: 'needs-you' });
    const reply = insertRun(db, {
      trigger: 'adhoc',
      adhoc_prompt: 'the answer',
      parent_run_id: first,
      outcome: 'acted',
    });
    const other = insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'unrelated' });

    const chats = read.runList({});
    expect(chats.map((r) => r.id)).toEqual([other, reply]);
    expect(chats[1]).toMatchObject({ adhocPrompt: 'first question', outcome: 'acted' });
    expect(read.runList({ q: 'the answer' }).map((r) => r.id)).toEqual([reply]);
    expect(read.runList({ limit: 1 }).map((r) => r.id)).toEqual([other]);
  });

  test('run list orders chats by their latest Run so an updated old chat stays on top', () => {
    const { db, read } = setup();
    const a = insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'chat A' });
    const b = insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'chat B' });
    const reply = insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'more A', parent_run_id: a });

    expect(read.runList({}).map((r) => r.id)).toEqual([reply, b]);
    expect(read.runList({ limit: 1 }).map((r) => r.id)).toEqual([reply]);
  });

  test('run list keeps a chat visible while its follow-up is queued', () => {
    const { db, read } = setup();
    const a = insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'chat A' });
    insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'more A', parent_run_id: a, status: 'queued' });
    insertRun(db, { trigger: 'adhoc', adhoc_prompt: 'only queued', status: 'queued' });

    expect(read.runList({}).map((r) => r.id)).toEqual([a]);
  });

  test('run history searches task, prompt, ticket, result, error and ID without treating wildcards specially', () => {
    const { db, read } = setup();
    const watch = insertWatch(db, { title: 'Review café navigation' });
    const watched = insertRun(db, { watch_id: watch, summary: 'Updated layout' });
    const adhoc = insertRun(db, {
      trigger: 'adhoc',
      adhoc_prompt: 'Check 100% of tasks',
      ticket_key: 'ABC-123',
      ticket_title: 'Fix redirect',
      error_json: JSON.stringify({ code: 'OFFLINE', message: 'Connection unavailable' }),
    });
    insertRun(db, { status: 'queued', adhoc_prompt: 'café' });

    expect(watched).toBeGreaterThan(0);
    expect(read.runList({ q: 'CAFÉ' })).toEqual([]);
    expect(read.runList({ q: 'layout' })).toEqual([]);
    expect(read.runList({ q: '100%' }).map((r) => r.id)).toEqual([adhoc]);
    expect(read.runList({ q: 'ABC-123' }).map((r) => r.id)).toEqual([adhoc]);
    expect(read.runList({ q: 'redirect' }).map((r) => r.id)).toEqual([adhoc]);
    expect(read.runList({ q: 'unavailable' }).map((r) => r.id)).toEqual([adhoc]);
    expect(read.runList({ q: `#${adhoc}` }).map((r) => r.id)).toEqual([adhoc]);
    expect(read.runList({ q: '%' })).toHaveLength(1);
    expect(read.runList({ q: 'not present' })).toEqual([]);
  });

  test('run history date range includes its start, excludes the next day and uses queued time before execution', () => {
    const { db, read } = setup();
    const from = Date.parse('2026-11-04T00:00:00Z');
    const before = Date.parse('2026-11-05T00:00:00Z');
    insertRun(db, { started_at: from - 1 });
    const first = insertRun(db, { started_at: from });
    const last = insertRun(db, { started_at: before - 1 });
    insertRun(db, { started_at: before });
    const failed = insertRun(db, { queued_at: from + 1, started_at: null, result_status: 'error' });
    insertRun(db, { queued_at: from + 1, status: 'queued' });

    expect(read.runList({ startedFrom: from, startedBefore: before }).map((r) => r.id)).toEqual([failed, last, first]);
    expect(read.runList({ startedFrom: from, startedBefore: before, outcome: 'error' }).map((r) => r.id)).toEqual([
      failed,
    ]);
  });

  test('resolved historical outcomes do not become current Home blockers', () => {
    const { db, read } = setup();
    const watch = insertWatch(db, { state: 'active' });
    insertRun(db, { watch_id: watch, outcome: 'needs-you', result_status: 'success' });
    insertRun(db, { watch_id: watch, result_status: 'error' });

    expect(read.homeView().needsYou).toEqual([]);
    expect(read.homeView().recent).toHaveLength(2);
  });

  test('run history uses the persisted provider after the global provider changes', async () => {
    const { db, read } = setup({ provider: 'codex' });
    const legacy = insertRun(db, { provider: 'copilot' });
    const selected = insertRun(db, { provider: 'codex' });

    expect(read.runList({}).map((run) => [run.id, run.provider])).toEqual([
      [selected, 'codex'],
      [legacy, 'copilot'],
    ]);
    expect((await read.runDetail(legacy))!.run.provider).toBe('copilot');
  });

  test('run detail truncates files over 5 MB', async () => {
    const { db, read, dataDir } = setup();
    const w = insertWatch(db, { title: 'Fix it' });
    const id = insertRun(db, { watch_id: w, result_status: 'success', outcome: 'acted' });
    dataDir.ensureRunDir(id);
    fs.writeFileSync(dataDir.transcriptPath(id), 'x'.repeat(5 * 1024 * 1024 + 10));
    fs.writeFileSync(dataDir.resultPath(id), '{"schemaVersion":1}');
    db.prepare('UPDATE runs SET transcript_path = ?, result_path = ? WHERE id = ?').run(
      dataDir.transcriptPath(id),
      dataDir.resultPath(id),
      id,
    );

    const detail = (await read.runDetail(id))!;

    expect(detail.run.id).toBe(id);
    expect(detail.watchTitle).toBe('Fix it');
    expect(detail.transcript.truncated).toBe(true);
    expect(detail.transcript.content).toHaveLength(5 * 1024 * 1024);
    expect(detail.result).toEqual({ path: dataDir.resultPath(id), content: '{"schemaVersion":1}', truncated: false });
    expect(detail.prompt).toEqual({ path: dataDir.promptPath(id), content: null, truncated: false });
    expect(await read.runDetail(9_999)).toBeNull();
  });

  test('Ticket-linked Runs expose the Ticket key, title and Jira link in every Run view', async () => {
    const { db, read, config } = setup();
    config.jira.connections.alternate = { baseUrl: 'https://jira.alternate.example.com' };
    db.prepare('UPDATE repositories SET jira = ? WHERE name = ?').run('alternate', 'pages');
    const linked = {
      trigger: 'adhoc',
      priority: 0,
      adhoc_prompt: 'p',
      ticket_key: 'ABC-123',
      ticket_title: 'Fix login redirect',
    };
    const ticket = {
      key: 'ABC-123',
      title: 'Fix login redirect',
      url: 'https://jira.alternate.example.com/browse/ABC-123',
    };
    const finished = insertRun(db, { ...linked, result_status: 'success', outcome: 'acted' });
    const running = insertRun(db, { ...linked, status: 'running', started_at: 5_000 });
    const queued = insertRun(db, { ...linked, status: 'queued', ticket_title: null });
    const plain = insertRun(db, { trigger: 'adhoc', priority: 0, adhoc_prompt: 'x', status: 'queued' });

    const queue = read.queueView();
    expect(queue.running[0]).toMatchObject({ runId: running, ticket });
    expect(queue.waiting.find((r) => r.runId === queued)).toMatchObject({
      ticket: { key: 'ABC-123', title: null, url: ticket.url },
    });
    expect(queue.waiting.find((r) => r.runId === plain)!.ticket).toBeNull();
    expect(read.runList({}).find((r) => r.id === finished)).toMatchObject({ ticket });
    expect(read.adhocView().rows.find((r) => r.id === finished)).toMatchObject({ ticket });
    expect((await read.runDetail(finished))!.ticket).toEqual(ticket);
  });

  test('Ticket URLs remain the link shown in Ad-hoc history', () => {
    const { db, read } = setup();
    const url = 'https://github.com/lacedon/Automator/issues/46';
    const id = insertRun(db, {
      trigger: 'adhoc',
      priority: 0,
      adhoc_prompt: null,
      ticket_key: url,
      ticket_title: null,
      status: 'queued',
    });

    expect(read.adhocView().rows.find((row) => row.id === id)!.ticket).toEqual({
      key: url,
      title: null,
      url,
    });
  });

  test('form options list repositories with gitlab host', () => {
    const { db, read, config } = setup({ runs: { models: ['gpt-5', 'claude-sonnet-4.5'] } });
    const persistedFolder = '/persisted/repositories/pages';
    db.prepare('UPDATE repositories SET folder = ? WHERE name = ?').run(persistedFolder, 'pages');

    const options = read.formOptions();

    expect(options.repositories).toEqual([
      { name: 'api', folder: config.repositories.api!.folder, host: 'https://gitlab.example.com', project: null },
      { name: 'pages', folder: persistedFolder, host: 'https://gitlab.example.com', project: null },
    ]);
    expect(options.models).toEqual(['claude-sonnet-4.5', 'gpt-5']);
    expect(options.defaultModel).toBe('claude-sonnet-4.5');
    expect(options.intervals).toEqual({ mr: 15 * MIN, default: 120 * MIN });
    expect(options.initialReview).toBe('baseline-only');
    expect(options.jiraEnabled).toBe(false);
    expect(options).not.toHaveProperty('defaultPromptFiles');
  });

  test('form options expose selected provider models', () => {
    const { db, read } = setup({
      provider: 'codex',
      providers: { codex: { defaultModel: 'codex-default', models: ['codex-fast'] } },
    });
    const watchId = insertWatch(db);

    expect(read.formOptions()).toMatchObject({
      provider: 'codex',
      defaultModel: 'codex-default',
      models: ['codex-default', 'codex-fast'],
    });
    expect(read.watchDetail(watchId)?.settings.model).toBe('codex-default');
  });

  test('adhoc view lists ad-hoc Runs newest first with queue position', () => {
    const { db, read } = setup();
    const done = insertRun(db, {
      trigger: 'adhoc',
      priority: 0,
      adhoc_prompt: 'one',
      result_status: 'success',
      outcome: 'acted',
    });
    const queued = insertRun(db, { trigger: 'adhoc', priority: 0, adhoc_prompt: 'two', status: 'queued' });
    insertRun(db, { watch_id: insertWatch(db), status: 'finished' });

    expect(read.adhocView().rows.map((r) => [r.id, r.prompt, r.status, r.queuePosition])).toEqual([
      [queued, 'two', 'queued', 1],
      [done, 'one', 'finished', null],
    ]);
  });

  describe('thread', () => {
    const adhoc = { trigger: 'adhoc', priority: 0, adhoc_prompt: 'p' };

    test('Automation Run has no thread', async () => {
      const { db, read } = setup();
      const id = insertRun(db, { watch_id: insertWatch(db) });

      expect((await read.runDetail(id))!.thread).toBeNull();
    });

    test('thread lists root to tip for any Run in the chain', async () => {
      const { db, read } = setup();
      const root = insertRun(db, { ...adhoc, adhoc_prompt: 'first', session_id: 's', summary: 'done 1' });
      const mid = insertRun(db, { ...adhoc, adhoc_prompt: 'second', parent_run_id: root, session_id: 's' });
      const tip = insertRun(db, { ...adhoc, adhoc_prompt: 'third', parent_run_id: mid, session_id: 's' });

      const fromRoot = (await read.runDetail(root))!.thread!;
      const fromTip = (await read.runDetail(tip))!.thread!;

      expect(fromRoot.runs.map((r) => r.id)).toEqual([root, mid, tip]);
      expect(fromTip.runs).toEqual(fromRoot.runs);
      expect(fromRoot.runs[0]).toMatchObject({
        id: root,
        status: 'finished',
        request: 'first',
        summary: 'done 1',
        error: null,
        ticketKey: null,
      });
    });

    test('reply target is the finished tip', async () => {
      const { db, read } = setup();
      const root = insertRun(db, { ...adhoc, session_id: 's' });
      const tip = insertRun(db, { ...adhoc, parent_run_id: root, session_id: 's2' });

      expect((await read.runDetail(root))!.thread).toMatchObject({ replyToRunId: tip, replyBlockedReason: null });
    });

    test('reply blocked while the tip is queued, with a reason naming the Run', async () => {
      const { db, read } = setup();
      const root = insertRun(db, { ...adhoc, session_id: 's' });
      const tip = insertRun(db, { ...adhoc, parent_run_id: root, status: 'queued' });

      expect((await read.runDetail(root))!.thread).toMatchObject({
        replyToRunId: null,
        replyBlockedReason: `Waiting for Run #${tip} to finish`,
      });
    });

    test('reply blocked when the finished tip has no Copilot session', async () => {
      const { db, read } = setup();
      const root = insertRun(db, adhoc);

      expect((await read.runDetail(root))!.thread).toMatchObject({
        replyToRunId: null,
        replyBlockedReason: 'No Copilot session to continue',
      });
    });

    test('reply blocked when the repository is no longer configured', async () => {
      const { db, read } = setup();
      const root = insertRun(db, { ...adhoc, repository: 'gone', session_id: 's' });

      expect((await read.runDetail(root))!.thread).toMatchObject({
        replyToRunId: null,
        replyBlockedReason: 'Repository "gone" is no longer configured',
      });
    });

    test('a prototype-key repository name is not treated as configured', async () => {
      const { db, read } = setup();
      const root = insertRun(db, { ...adhoc, repository: 'constructor', session_id: 's' });

      expect((await read.runDetail(root))!.thread).toMatchObject({
        replyToRunId: null,
        replyBlockedReason: 'Repository "constructor" is no longer configured',
      });
    });

    test('thread of a follow-up whose parent was deleted starts at the follow-up', async () => {
      const { db, read } = setup();
      const root = insertRun(db, { ...adhoc, session_id: 's' });
      const child = insertRun(db, { ...adhoc, parent_run_id: root, session_id: 's' });
      db.prepare('DELETE FROM runs WHERE id = ?').run(root);

      expect((await read.runDetail(child))!.thread!.runs.map((r) => r.id)).toEqual([child]);
    });

    test('a corrupt parent cycle terminates', async () => {
      const { db, read } = setup();
      const a = insertRun(db, { ...adhoc, session_id: 's' });
      const b = insertRun(db, { ...adhoc, parent_run_id: a, session_id: 's' });
      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run(b, a);

      expect((await read.runDetail(a))!.thread!.runs.map((r) => r.id).sort()).toEqual([a, b].sort());
    });
  });
});
