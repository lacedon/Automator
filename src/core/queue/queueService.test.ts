import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig, type DeepPartial } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { ProviderName } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { QueueService } from './queueService';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(
  opts: {
    ticketTitle?: (conn: string, key: string) => Promise<string>;
    jiraEnabled?: boolean;
    configOverrides?: DeepPartial<Config>;
  } = {},
) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const dataDir = new DataDir(path.dirname(t.file));
  const config = testConfig({
    ...opts.configOverrides,
    runs: { defaultModel: 'default-model', ...opts.configOverrides?.runs },
    jira: { enabled: opts.jiraEnabled ?? true, ...opts.configOverrides?.jira },
  });
  const repositories = testRepositories(t.db, config);
  return {
    db: t.db,
    file: t.file,
    clock,
    dataDir,
    config,
    repositories,
    queue: new QueueService(t.db, clock, dataDir, config, repositories, { ticketTitle: opts.ticketTitle }),
  };
}

function statuses(db: Database): { id: number; status: string }[] {
  return db.prepare('SELECT id, status FROM runs ORDER BY id').all() as { id: number; status: string }[];
}

const base = { repository: 'pages', model: 'm' };

describe('QueueService', () => {
  test('new Runs snapshot the selected provider and default model', async () => {
    const { queue } = setup({
      configOverrides: {
        provider: 'codex',
        providers: { codex: { defaultModel: 'codex-model' } },
      },
    });

    const result = await queue.requestAdhoc({ repository: 'pages', prompt: 'do it' });

    expect(result).toMatchObject({
      ok: true,
      value: { run: { provider: 'codex', model: 'codex-model' } },
    });
  });

  test('stores the chosen Agent on an ad-hoc Run and rejects an unknown one', async () => {
    const { db, queue } = setup();
    const agentId = (db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: number }).id;
    const chosen = await queue.requestAdhoc({ repository: 'pages', prompt: 'p', agentId });
    expect(chosen).toMatchObject({ ok: true, value: { run: { agentId } } });
    const plain = await queue.requestAdhoc({ repository: 'pages', prompt: 'p' });
    expect(plain).toMatchObject({ ok: true, value: { run: { agentId: null } } });
    const unknown = await queue.requestAdhoc({ repository: 'pages', prompt: 'p', agentId: 9999 });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'agentId' } });
  });

  test('rejects ad-hoc models not configured for the selected provider', async () => {
    const { db, queue } = setup({
      configOverrides: { provider: 'codex', providers: { codex: { defaultModel: 'codex' } } },
    });

    const result = await queue.requestAdhoc({ repository: 'pages', prompt: 'do it', model: 'unknown-model' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'model', message: 'Model "unknown-model" is not configured for codex' },
    });
    expect(statuses(db)).toEqual([]);
  });

  test('orders manual and adhoc before scheduled, then FIFO', () => {
    const { db, clock, queue } = setup();
    const w1 = insertWatch(db);
    const w2 = insertWatch(db);
    const w3 = insertWatch(db);
    const s1 = queue.enqueueWatch({ ...base, watchId: w1, trigger: 'schedule', reason: 's1' });
    clock.advance(1000);
    const m1 = queue.enqueueWatch({ ...base, watchId: w2, trigger: 'manual', reason: 'm1' });
    clock.advance(1000);
    const a1 = queue.enqueueAdhoc({ ...base, prompt: 'do it' });
    clock.advance(1000);
    const s2 = queue.enqueueWatch({ ...base, watchId: w3, trigger: 'schedule', reason: 's2' });

    expect(s1.priority).toBe(1);
    expect(m1.priority).toBe(0);
    expect(a1).toMatchObject({ priority: 0, trigger: 'adhoc', watchId: null, reason: 'ad-hoc', adhocPrompt: 'do it' });
    expect([m1, a1, s1, s2].map((r) => queue.position(r.id))).toEqual([1, 2, 3, 4]);

    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      const run = queue.claimNext();
      expect(run).not.toBeNull();
      expect(run!.status).toBe('running');
      expect(run!.startedAt).toBe(clock.now());
      order.push(run!.id);
      db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(run!.id);
    }
    expect(order).toEqual([m1.id, a1.id, s1.id, s2.id]);
    expect(queue.position(m1.id)).toBeNull();
    expect(queue.claimNext()).toBeNull();
  });

  test('coalescing does not change a queued Run provider or model', () => {
    const { db, clock, queue, config } = setup();
    const w = insertWatch(db);
    const first = queue.enqueueWatch({ ...base, watchId: w, trigger: 'schedule', reason: 'r1' });
    config.provider = 'codex';
    clock.advance(1000);
    queue.enqueueWatch({
      ...base,
      watchId: w,
      trigger: 'manual',
      reason: 'r2',
      extraInstructions: 'A',
      reviewUnresolved: true,
    });
    clock.advance(1000);
    const merged = queue.enqueueWatch({
      ...base,
      watchId: w,
      trigger: 'manual',
      reason: 'r3',
      extraInstructions: 'A\n\nB',
      model: 'newer-model',
    });

    expect(statuses(db)).toHaveLength(1);
    expect(merged).toMatchObject({
      id: first.id,
      priority: 0,
      trigger: 'manual',
      extraInstructions: 'A\n\nB',
      reviewUnresolved: true,
      reason: 'r1; r2; r3',
      queuedAt: first.queuedAt,
      provider: 'copilot',
      model: 'm',
      repository: 'pages',
    });
  });

  test('claimNext returns null while a run is running', () => {
    const { db, queue } = setup();
    const running = queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    queue.enqueueAdhoc({ ...base, prompt: 'p2' });
    expect(queue.claimNext()?.id).toBe(running.id);
    expect(queue.claimNext()).toBeNull();
    expect(statuses(db).map((r) => r.status)).toEqual(['running', 'queued']);
  });

  test('claimNext runs different Repositories together without a busy one blocking the rest', () => {
    const { db, queue } = setup();
    const p1 = queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    const p2 = queue.enqueueAdhoc({ ...base, prompt: 'p2' });
    const a1 = queue.enqueueAdhoc({ ...base, repository: 'api', prompt: 'a1' });
    expect(queue.claimNext()?.id).toBe(p1.id);
    expect(queue.claimNext()?.id).toBe(a1.id);
    expect(queue.claimNext()).toBeNull();
    expect(statuses(db).map((r) => r.status)).toEqual(['running', 'queued', 'running']);
    db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(p1.id);
    expect(queue.claimNext()?.id).toBe(p2.id);
  });

  test('Repository records sharing a checkout share the lock', () => {
    const { queue, config, db } = setup();
    db.prepare("INSERT INTO repositories (name, folder, validate_json) VALUES ('pages-alias', ?, '[]')").run(
      config.repositories.pages.folder,
    );
    const first = queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    queue.enqueueAdhoc({ ...base, repository: 'pages-alias', prompt: 'p2' });
    expect(queue.claimNext()?.id).toBe(first.id);
    expect(queue.claimNext()).toBeNull();
    expect(statuses(db).map((r) => r.status)).toEqual(['running', 'queued']);
  });

  test('copy isolation runs the same Repository up to maxConcurrent, then queues', () => {
    const { db, queue } = setup({ configOverrides: { runs: { isolation: 'copy', maxConcurrent: 2 } } });
    const ids = [1, 2, 3].map((n) => queue.enqueueAdhoc({ ...base, prompt: `p${n}` }).id);
    expect(queue.claimNext()?.id).toBe(ids[0]);
    expect(queue.claimNext()?.id).toBe(ids[1]);
    expect(queue.claimNext()).toBeNull();
    expect(db.prepare('SELECT isolation FROM runs WHERE id = ?').get(ids[0])).toEqual({ isolation: 'copy' });
    db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(ids[0]);
    expect(queue.claimNext()?.id).toBe(ids[2]);
  });

  test('a shared Run waits for a copy Run on the same checkout, and a copy Run waits for a shared one', () => {
    const { db, queue, config } = setup();
    const shared = queue.enqueueAdhoc({ ...base, prompt: 'shared' });
    expect(queue.claimNext()?.id).toBe(shared.id);
    config.runs.isolation = 'copy';
    const copy = queue.enqueueAdhoc({ ...base, prompt: 'copy' });
    expect(queue.claimNext()).toBeNull();
    db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(shared.id);
    expect(queue.claimNext()?.id).toBe(copy.id);
    config.runs.isolation = 'shared';
    queue.enqueueAdhoc({ ...base, prompt: 'shared 2' });
    expect(queue.claimNext()).toBeNull();
  });

  test('claimNext drops rows for closed or needs_you watches and scheduled rows for paused watches', () => {
    const { db, queue } = setup();
    const closed = insertWatch(db, { state: 'closed' });
    const needsYou = insertWatch(db, { state: 'needs_you' });
    const paused = insertWatch(db, { state: 'paused' });
    const active = insertWatch(db);
    queue.enqueueWatch({ ...base, watchId: closed, trigger: 'manual', reason: 'x' });
    queue.enqueueWatch({ ...base, watchId: needsYou, trigger: 'manual', reason: 'x' });
    queue.enqueueWatch({ ...base, watchId: paused, trigger: 'schedule', reason: 'x' });
    const ok = queue.enqueueWatch({ ...base, watchId: active, trigger: 'schedule', reason: 'x' });

    expect(queue.claimNext()?.id).toBe(ok.id);
    expect(statuses(db)).toEqual([{ id: ok.id, status: 'running' }]);
  });

  test('manual row for paused watch is claimed', () => {
    const { db, queue } = setup();
    const paused = insertWatch(db, { state: 'paused' });
    const run = queue.enqueueWatch({ ...base, watchId: paused, trigger: 'manual', reason: 'x' });
    expect(queue.claimNext()?.id).toBe(run.id);
  });

  test('two connections claiming concurrently yield one running row', async () => {
    const { db, file, dataDir, queue } = setup();
    queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    queue.enqueueAdhoc({ ...base, prompt: 'p2' });
    const barrier = new SharedArrayBuffer(4);
    const fixture = path.resolve('test/fixtures/claimWorker.ts');
    const claim = () =>
      new Promise<number | null>((resolve, reject) => {
        const worker = new Worker(fixture, {
          execArgv: ['--import', 'tsx'],
          workerData: { file, root: dataDir.root, barrier },
        });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error(`claim worker exited with code ${code} before replying`)));
      });

    const results = await Promise.all([claim(), claim()]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    const running = statuses(db).filter((r) => r.status === 'running');
    expect(running).toHaveLength(1);
    expect(results).toContain(running[0].id);
  });

  test('cancel deletes queued, flags running, rejects finished with INVALID_STATE', () => {
    const { db, clock, queue } = setup();
    const running = queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    const queued = queue.enqueueAdhoc({ ...base, prompt: 'p2' });
    queue.claimNext();
    clock.advance(5000);

    expect(queue.cancel(queued.id)).toEqual({ ok: true, value: 'deleted' });
    expect(queue.cancel(running.id)).toEqual({ ok: true, value: 'cancel-requested' });
    expect(db.prepare('SELECT cancel_requested_at FROM runs WHERE id = ?').get(running.id)).toEqual({
      cancel_requested_at: clock.now(),
    });
    expect(statuses(db)).toEqual([{ id: running.id, status: 'running' }]);

    db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(running.id);
    expect(queue.cancel(running.id)).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'finished', action: 'cancel' },
    });
    expect(queue.cancel(9999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('cancelQueued deletes only queued rows and never touches a running one', () => {
    const { db, queue } = setup();
    const running = queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    const queued = queue.enqueueAdhoc({ ...base, prompt: 'p2' });
    queue.claimNext();

    expect(queue.cancelQueued(running.id)).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'running', action: 'cancelQueued' },
    });
    expect(db.prepare('SELECT cancel_requested_at FROM runs WHERE id = ?').get(running.id)).toEqual({
      cancel_requested_at: null,
    });
    expect(queue.cancelQueued(queued.id)).toEqual({ ok: true, value: undefined });
    expect(statuses(db)).toEqual([{ id: running.id, status: 'running' }]);
    expect(queue.cancelQueued(queued.id)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('closeRun marks only finished Needs you or Error Runs as closed, once', () => {
    const { db, queue } = setup();
    const ids = [1, 2, 3].map((n) => queue.enqueueAdhoc({ ...base, prompt: `p${n}` }).id);
    const [needsYou, errored, acted] = ids as [number, number, number];
    expect(queue.closeRun(needsYou)).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'queued', action: 'closeRun' },
    });
    db.prepare("UPDATE runs SET status = 'finished', outcome = 'needs-you' WHERE id = ?").run(needsYou);
    db.prepare("UPDATE runs SET status = 'finished', result_status = 'error' WHERE id = ?").run(errored);
    db.prepare("UPDATE runs SET status = 'finished', outcome = 'acted' WHERE id = ?").run(acted);

    expect(queue.closeRun(acted)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(queue.closeRun(needsYou)).toEqual({ ok: true, value: undefined });
    expect(queue.closeRun(errored)).toEqual({ ok: true, value: undefined });
    expect(queue.closeRun(needsYou)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(queue.closeRun(9999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(db.prepare('SELECT id FROM runs WHERE closed_at IS NOT NULL ORDER BY id').all()).toEqual([
      { id: needsYou },
      { id: errored },
    ]);
  });

  test('deleteAdhoc removes finished adhoc row and its run dir; rejects watch runs and unfinished', () => {
    const { db, dataDir, queue } = setup();
    const w = insertWatch(db);
    const adhoc = queue.enqueueAdhoc({ ...base, prompt: 'p1' });
    const watchRun = queue.enqueueWatch({ ...base, watchId: w, trigger: 'manual', reason: 'x' });

    expect(queue.deleteAdhoc(adhoc.id)).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'queued', action: 'deleteAdhoc' },
    });

    db.prepare("UPDATE runs SET status = 'finished'").run();
    expect(queue.deleteAdhoc(watchRun.id)).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'finished', action: 'deleteAdhoc' },
    });

    const dir = dataDir.ensureRunDir(adhoc.id);
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'x');
    expect(queue.deleteAdhoc(adhoc.id)).toEqual({ ok: true, value: undefined });
    expect(fs.existsSync(dir)).toBe(false);
    expect(statuses(db)).toEqual([{ id: watchRun.id, status: 'finished' }]);
    expect(queue.deleteAdhoc(adhoc.id)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('removeQueuedForWatch deletes only that watch queued row', () => {
    const { db, queue } = setup();
    const w1 = insertWatch(db);
    const w2 = insertWatch(db);
    queue.enqueueWatch({ ...base, watchId: w1, trigger: 'manual', reason: 'x' });
    const keep = queue.enqueueWatch({ ...base, watchId: w2, trigger: 'manual', reason: 'x' });
    queue.removeQueuedForWatch(w1);
    expect(statuses(db)).toEqual([{ id: keep.id, status: 'queued' }]);
  });

  test('unknown repository writes attempt file and queues nothing', async () => {
    const { db, clock, queue } = setup();
    const r = await queue.requestAdhoc({ repository: 'nope', prompt: 'p' });
    if (r.ok || r.error.code !== 'UNKNOWN_REPOSITORY') throw new Error('expected UNKNOWN_REPOSITORY');
    expect(r.error).toMatchObject({ name: 'nope', known: ['api', 'pages'] });
    expect(r.error.attemptFileError).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(r.error.attemptFile as string, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      at: new Date(clock.now()).toISOString(),
      status: 'error',
      error: { code: 'UNKNOWN_REPOSITORY', name: 'nope', known: ['api', 'pages'] },
    });
    expect(statuses(db)).toEqual([]);
  });

  test('checked adhoc enqueue uses default model', async () => {
    const { queue } = setup({ configOverrides: { runs: { models: ['m2'] } } });
    const r = await queue.requestAdhoc({ repository: 'pages', prompt: 'p' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.run).toMatchObject({
      repository: 'pages',
      adhocPrompt: 'p',
      model: 'default-model',
      status: 'queued',
    });
    const explicit = await queue.requestAdhoc({ repository: 'pages', prompt: 'p', model: 'm2' });
    expect(explicit.ok && explicit.value.run.model).toBe('m2');
  });
});

describe('QueueService.requestAdhoc', () => {
  test('does not enqueue under a Repository name renamed during Ticket title lookup', async () => {
    let releaseTitle!: (title: string) => void;
    const title = new Promise<string>((resolve) => {
      releaseTitle = resolve;
    });
    const { db, queue, repositories } = setup({ ticketTitle: async () => title });

    const pending = queue.requestAdhoc({ repository: 'pages', ticket: 'ABC-123' });
    const repository = repositories.get('pages');
    if (repository === null) throw new Error('test Repository missing');
    expect(repositories.update('pages', { ...repository, name: 'renamed-pages' }).ok).toBe(true);
    releaseTitle('Ticket title');

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_REPOSITORY', name: 'pages', known: ['api', 'renamed-pages'] },
    });
    expect(statuses(db)).toEqual([]);
  });

  test('stores the Ticket key and the fetched title on the Run', async () => {
    const lookups: [string, string][] = [];
    const { queue } = setup({
      ticketTitle: async (conn, key) => {
        lookups.push([conn, key]);
        return 'Fix login redirect';
      },
    });

    const result = await queue.requestAdhoc({ repository: 'pages', prompt: 'Do it', ticket: 'abc-123' });

    expect(result).toMatchObject({
      ok: true,
      value: { run: { trigger: 'adhoc', ticketKey: 'ABC-123', ticketTitle: 'Fix login redirect' } },
    });
    expect(lookups).toEqual([['corp', 'ABC-123']]);
  });

  test('resolves the Jira connection from the persisted Repository row', async () => {
    const lookups: string[] = [];
    const { db, config, queue } = setup({
      ticketTitle: async (conn) => {
        lookups.push(conn);
        return 'Persisted connection';
      },
    });
    config.jira.connections.alternate = { baseUrl: 'https://jira.alternate.example.com' };
    db.prepare('UPDATE repositories SET jira = ? WHERE name = ?').run('alternate', 'pages');

    const result = await queue.requestAdhoc({ repository: 'pages', ticket: 'ABC-22' });

    expect(result).toMatchObject({ ok: true, value: { run: { ticketKey: 'ABC-22' } } });
    expect(lookups).toEqual(['alternate']);
  });

  test('preserves Jira URLs instead of parsing them as Jira keys', async () => {
    const lookups: string[] = [];
    const { queue } = setup({
      ticketTitle: async (_conn, key) => {
        lookups.push(key);
        return 'T';
      },
    });
    const url = 'https://jira.example.com/browse/abc-7?ref=source#details';

    const result = await queue.requestAdhoc({
      repository: 'pages',
      prompt: 'Do it',
      ticket: url,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { run: { ticketKey: url, ticketTitle: null } },
    });
    expect(lookups).toEqual([]);
  });

  test('accepts a URL without Jira enabled or a Jira connection', async () => {
    const { db, queue } = setup({ jiraEnabled: false });
    const url = 'https://github.com/lacedon/Automator/issues/46';

    const result = await queue.requestAdhoc({ repository: 'api', ticket: url });

    expect(result).toMatchObject({
      ok: true,
      value: { run: { status: 'queued', ticketKey: url, ticketTitle: null, adhocPrompt: null } },
    });
    expect(statuses(db)).toHaveLength(1);
  });

  test('still queues the Run with the key only, plus a warning, when the title lookup fails', async () => {
    const { queue } = setup({
      ticketTitle: async () => {
        throw new Error('Jira token missing');
      },
    });

    const result = await queue.requestAdhoc({ repository: 'pages', prompt: 'Do it', ticket: 'ABC-123' });

    expect(result).toMatchObject({
      ok: true,
      value: {
        run: { status: 'queued', ticketKey: 'ABC-123', ticketTitle: null },
        warning: 'Could not fetch the Ticket title: Jira token missing',
      },
    });
  });

  test.each([
    ['a malformed Ticket', 'pages', 'not a ticket', true, { code: 'INVALID_INPUT', field: 'ticket' }],
    ['a bare key on a Repository without Jira', 'api', 'ABC-1', true, { code: 'INVALID_INPUT', field: 'ticket' }],
    ['Jira disabled', 'pages', 'ABC-1', false, { code: 'JIRA_DISABLED' }],
  ])('rejects %s and queues nothing', async (_name, repository, ticket, jiraEnabled, error) => {
    const { db, queue } = setup({ jiraEnabled });

    const result = await queue.requestAdhoc({ repository, prompt: 'Do it', ticket });

    expect(result).toMatchObject({ ok: false, error });
    expect(statuses(db)).toEqual([]);
  });

  test('allows a blank prompt only when a Ticket is linked', async () => {
    const { db, queue } = setup({ ticketTitle: async () => 'T' });

    expect(await queue.requestAdhoc({ repository: 'pages', prompt: '  ', ticket: 'ABC-1' })).toMatchObject({
      ok: true,
      value: { run: { adhocPrompt: null, ticketKey: 'ABC-1' } },
    });
    expect(await queue.requestAdhoc({ repository: 'pages', prompt: '  ' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'prompt' },
    });
    expect(statuses(db)).toHaveLength(1);
  });

  test('queues a Run without a Ticket and does not deduplicate Runs for the same Ticket', async () => {
    const { db, queue } = setup({ ticketTitle: async () => 'T' });

    await queue.requestAdhoc({ repository: 'pages', prompt: 'plain' });
    await queue.requestAdhoc({ repository: 'pages', prompt: 'again', ticket: 'ABC-1' });
    await queue.requestAdhoc({ repository: 'pages', prompt: 'again', ticket: 'ABC-1' });

    expect(statuses(db)).toHaveLength(3);
  });
});

describe('QueueService.requestFollowUp', () => {
  function finishedAdhoc(
    ctx: ReturnType<typeof setup>,
    over: {
      repository?: string;
      provider?: ProviderName;
      sessionId?: string | null;
      status?: string;
    } = {},
  ) {
    const run = ctx.queue.enqueueAdhoc({
      repository: over.repository ?? 'pages',
      prompt: 'first',
      model: 'opus',
      provider: over.provider,
    });
    ctx.db
      .prepare('UPDATE runs SET status = ?, session_id = ? WHERE id = ?')
      .run(over.status ?? 'finished', over.sessionId === undefined ? 'sess-1' : over.sessionId, run.id);
    return run;
  }

  test('follow-up inherits provider, model, and session', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx, { provider: 'codex' });
    ctx.config.provider = 'copilot';

    const result = ctx.queue.requestFollowUp(parent.id, '  and now this  ');

    expect(result).toMatchObject({
      ok: true,
      value: {
        run: {
          status: 'queued',
          trigger: 'adhoc',
          repository: 'pages',
          provider: 'codex',
          model: 'opus',
          adhocPrompt: 'and now this',
          parentRunId: parent.id,
          sessionId: 'sess-1',
          ticketKey: null,
          ticketTitle: null,
        },
      },
    });
  });

  test('rejects an unknown Run', () => {
    expect(setup().queue.requestFollowUp(999, 'hi')).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('rejects an Automation Run', () => {
    const ctx = setup();
    const run = ctx.queue.enqueueWatch({ ...base, watchId: insertWatch(ctx.db), trigger: 'manual', reason: 'r' });
    ctx.db.prepare("UPDATE runs SET status = 'finished', session_id = 's' WHERE id = ?").run(run.id);

    expect(ctx.queue.requestFollowUp(run.id, 'hi')).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'run', message: 'Chat is only available for ad-hoc Runs' },
    });
  });

  test.each([
    ['empty', '  \n ', 'Message is required'],
    ['too long', 'x'.repeat(20_001), 'Message is too long (max 20000 characters)'],
  ])('rejects a message that is %s', (_name, message, text) => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx);

    expect(ctx.queue.requestFollowUp(parent.id, message)).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'message', message: text },
    });
    expect(statuses(ctx.db)).toHaveLength(1);
  });

  test('message of 20001 characters is rejected, 20000 accepted', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx);

    expect(ctx.queue.requestFollowUp(parent.id, 'x'.repeat(20_001)).ok).toBe(false);
    expect(ctx.queue.requestFollowUp(parent.id, 'x'.repeat(20_000)).ok).toBe(true);
  });

  test('validates the message before the Run state', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx, { status: 'running' });

    expect(ctx.queue.requestFollowUp(parent.id, '')).toMatchObject({ error: { field: 'message' } });
  });

  test('rejects a Run that has not finished', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx, { status: 'running' });

    expect(ctx.queue.requestFollowUp(parent.id, 'hi')).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'running', action: 'followUp' },
    });
  });

  test('a second follow-up on the same Run is rejected', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx);

    expect(ctx.queue.requestFollowUp(parent.id, 'one').ok).toBe(true);
    expect(ctx.queue.requestFollowUp(parent.id, 'two')).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'run', message: 'Reply on the latest Run in the thread' },
    });
    const children = ctx.db.prepare('SELECT id FROM runs WHERE parent_run_id = ?').all(parent.id);
    expect(children).toHaveLength(1);
  });

  test('rejects a Run without a provider session', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx, { sessionId: null });

    expect(ctx.queue.requestFollowUp(parent.id, 'hi')).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'run', message: 'This Run has no provider session to continue' },
    });
  });

  test('removed Repository gives UNKNOWN_REPOSITORY and creates no Run', () => {
    const ctx = setup();
    const parent = finishedAdhoc(ctx, { repository: 'removed' });

    expect(ctx.queue.requestFollowUp(parent.id, 'hi')).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_REPOSITORY', name: 'removed' },
    });
    expect(statuses(ctx.db)).toHaveLength(1);
  });
});

describe('QueueService workflow types', () => {
  const workflowOf = (db: Database, id: number) =>
    (db.prepare('SELECT workflow_type FROM runs WHERE id = ?').get(id) as { workflow_type: string }).workflow_type;

  test.each([
    ['mr', 'mr-watch'],
    ['jira', 'jira-watch'],
    ['free', 'free-watch'],
  ] as const)('a %s Automation Run persists %s', (kind, expected) => {
    const { db, queue } = setup();
    const watchId = insertWatch(db, { kind });
    const run = queue.enqueueWatch({ watchId, repository: 'pages', trigger: 'manual', reason: 'r', model: 'm' });
    expect(run.workflowType).toBe(expected);
    queue.enqueueWatch({ watchId, repository: 'pages', trigger: 'schedule', reason: 'again', model: 'm' });
    expect(workflowOf(db, run.id)).toBe(expected);
  });

  test('ad-hoc Runs persist ticket-adhoc or free-adhoc', async () => {
    const { queue } = setup({ ticketTitle: async () => 'Title' });
    const free = await queue.requestAdhoc({ repository: 'pages', prompt: 'do it' });
    const ticket = await queue.requestAdhoc({ repository: 'pages', ticket: 'ABC-1' });
    expect(free.ok && free.value.run.workflowType).toBe('free-adhoc');
    expect(ticket.ok && ticket.value.run.workflowType).toBe('ticket-adhoc');
  });

  test('follow-ups inherit the root Run workflow type through the chain', async () => {
    const ctx = setup({ ticketTitle: async () => 'Title' });
    const root = await ctx.queue.requestAdhoc({ repository: 'pages', ticket: 'ABC-1' });
    if (!root.ok) throw new Error('enqueue failed');
    ctx.db.prepare("UPDATE runs SET status = 'finished', session_id = 's' WHERE id = ?").run(root.value.run.id);
    const first = ctx.queue.requestFollowUp(root.value.run.id, 'one');
    if (!first.ok) throw new Error('follow-up failed');
    ctx.db.prepare("UPDATE runs SET status = 'finished', session_id = 's' WHERE id = ?").run(first.value.run.id);
    const second = ctx.queue.requestFollowUp(first.value.run.id, 'two');
    expect(first.value.run.workflowType).toBe('ticket-adhoc');
    expect(second.ok && second.value.run.workflowType).toBe('ticket-adhoc');
  });
});

describe('requestBranch', () => {
  function finishedAdhoc(ctx: ReturnType<typeof setup>, over: { status?: string } = {}) {
    const run = ctx.queue.enqueueAdhoc({ repository: 'pages', prompt: 'first', model: 'opus' });
    ctx.db
      .prepare('UPDATE runs SET status = ?, session_id = ? WHERE id = ?')
      .run(over.status ?? 'finished', 'sess-1', run.id);
    return run;
  }

  test('creates an independent Run carrying the conversation up to the selected response', () => {
    const ctx = setup();
    const first = finishedAdhoc(ctx);
    ctx.db.prepare("UPDATE runs SET adhoc_prompt = 'one', summary = 'answer one' WHERE id = ?").run(first.id);
    const reply = ctx.queue.requestFollowUp(first.id, 'two');
    if (!reply.ok) throw new Error('setup');
    ctx.db.prepare("UPDATE runs SET status = 'finished', summary = 'answer two' WHERE id = ?").run(reply.value.run.id);

    const result = ctx.queue.requestBranch(first.id, 'three');
    if (!result.ok) throw new Error('branch failed');
    const run = result.value.run;
    expect(run).toMatchObject({
      parentRunId: null,
      sessionId: null,
      branchedFromRunId: first.id,
      adhocPrompt: 'three',
    });
    expect(run.branchContext).toContain('User: one');
    expect(run.branchContext).toContain('Agent: answer one');
    expect(run.branchContext).not.toContain('answer two');
    // The original chat is unchanged.
    expect(ctx.db.prepare('SELECT count(*) AS n FROM runs WHERE parent_run_id = ?').get(first.id)).toEqual({ n: 1 });
  });

  test('includes earlier exchanges when branching from a later response', () => {
    const ctx = setup();
    const first = finishedAdhoc(ctx);
    ctx.db.prepare("UPDATE runs SET adhoc_prompt = 'one', summary = 'answer one' WHERE id = ?").run(first.id);
    const reply = ctx.queue.requestFollowUp(first.id, 'two');
    if (!reply.ok) throw new Error('setup');
    ctx.db.prepare("UPDATE runs SET status = 'finished', summary = 'answer two' WHERE id = ?").run(reply.value.run.id);

    const result = ctx.queue.requestBranch(reply.value.run.id, 'three');
    if (!result.ok) throw new Error('branch failed');
    expect(result.value.run.branchContext).toContain('answer one');
    expect(result.value.run.branchContext).toContain('answer two');
  });

  test('keeps the earlier chat context when branching a branched chat', () => {
    const ctx = setup();
    const first = finishedAdhoc(ctx);
    ctx.db.prepare("UPDATE runs SET adhoc_prompt = 'one', summary = 'answer one' WHERE id = ?").run(first.id);
    const b = ctx.queue.requestBranch(first.id, 'two');
    if (!b.ok) throw new Error('setup');
    ctx.db
      .prepare("UPDATE runs SET status = 'finished', session_id = 'sess-2', summary = 'answer two' WHERE id = ?")
      .run(b.value.run.id);
    const reply = ctx.queue.requestFollowUp(b.value.run.id, 'three');
    if (!reply.ok) throw new Error('setup');
    ctx.db
      .prepare("UPDATE runs SET status = 'finished', summary = 'answer three' WHERE id = ?")
      .run(reply.value.run.id);

    const result = ctx.queue.requestBranch(reply.value.run.id, 'four');
    if (!result.ok) throw new Error('branch failed');
    const context = result.value.run.branchContext ?? '';
    expect(context).toContain('answer one');
    expect(context).toContain('answer two');
    expect(context).toContain('answer three');
    expect(context).toContain('### Exchange 1');
    expect(context).toContain('### Exchange 3');
    expect(context).not.toContain('### Exchange 4');
  });

  test('rejects an unfinished Run, an empty message and an unknown Run', () => {
    const ctx = setup();
    const running = finishedAdhoc(ctx, { status: 'running' });
    expect(ctx.queue.requestBranch(running.id, 'x')).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'running', action: 'branch' },
    });
    const done = finishedAdhoc(ctx);
    expect(ctx.queue.requestBranch(done.id, ' ')).toMatchObject({ error: { field: 'message' } });
    expect(ctx.queue.requestBranch(9999, 'x')).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
