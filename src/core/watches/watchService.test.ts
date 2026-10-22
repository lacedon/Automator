import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { Result } from '../domain/result';
import { DataDir } from '../files/dataDir';
import { QueueService } from '../queue/queueService';
import { WatchService, type WatchServiceDeps, type TargetPreview } from './watchService';

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MR = 'https://gitlab.example.com/team/app/-/merge_requests/42';

function setup(opts: { config?: Config; preview?: WatchServiceDeps['preview'] } = {}) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const dataDir = new DataDir(path.dirname(t.file));
  const config = opts.config ?? testConfig();
  const queue = new QueueService(t.db, clock, dataDir, config);
  const service = new WatchService({ db: t.db, clock, config, queue, dataDir, preview: opts.preview });
  return { db: t.db, clock, dataDir, config, queue, service };
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function queued(db: Database) {
  return db
    .prepare(
      "SELECT watch_id, trigger, reason, model, extra_instructions, review_unresolved FROM runs WHERE status = 'queued'",
    )
    .all();
}

describe('WatchService.create', () => {
  test('create unknown repository writes attempt file and saves nothing', () => {
    const { db, service, clock } = setup();
    const r = service.create({ target: MR, repository: 'nope' });
    if (r.ok || r.error.code !== 'UNKNOWN_REPOSITORY') throw new Error('expected UNKNOWN_REPOSITORY');
    expect(r.error).toMatchObject({ name: 'nope', known: ['api', 'pages'] });
    expect(r.error.attemptFileError).toBeUndefined();
    const file = r.error.attemptFile as string;
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      at: new Date(clock.now()).toISOString(),
      status: 'error',
      error: { code: 'UNKNOWN_REPOSITORY', name: 'nope', known: ['api', 'pages'] },
    });
    expect(count(db, 'watches')).toBe(0);
  });

  test('create unknown repository reports attempt write failure', () => {
    const { db, service, dataDir } = setup();
    fs.writeFileSync(dataDir.attemptsDir, 'not a dir');
    const r = service.create({ target: MR, repository: 'nope' });
    if (r.ok || r.error.code !== 'UNKNOWN_REPOSITORY') throw new Error('expected UNKNOWN_REPOSITORY');
    expect(r.error.attemptFile).toBeNull();
    expect(r.error.attemptFileError).toEqual(expect.any(String));
    expect(count(db, 'watches')).toBe(0);
  });

  test('invalid target is INVALID_TARGET', () => {
    const { service } = setup();
    expect(service.create({ target: 'not a url', repository: 'pages' })).toEqual({
      ok: false,
      error: { code: 'INVALID_TARGET', message: 'Not a URL or Jira key: not a url' },
    });
  });

  test('free-form requires instructions', () => {
    const { db, service } = setup();
    const missing = { ok: false, error: { code: 'MISSING_INSTRUCTIONS' } };
    expect(service.create({ target: 'https://example.com/doc', repository: 'pages' })).toEqual(missing);
    expect(service.create({ target: 'https://example.com/doc', repository: 'pages', instructions: '  ' })).toEqual(missing);
    expect(count(db, 'watches')).toBe(0);
    const w = value(service.create({ target: 'https://example.com/doc', repository: 'pages', instructions: 'Summarize' }));
    expect(w).toMatchObject({ kind: 'free', instructions: 'Summarize' });
  });

  test('invalid intervalMs is INVALID_INPUT', () => {
    const { db, service } = setup();
    for (const intervalMs of [0, -5, 1.5]) {
      const r = service.create({ target: MR, repository: 'pages', intervalMs });
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'intervalMs' } });
    }
    expect(count(db, 'watches')).toBe(0);
  });

  test('duplicate returns existing watch', () => {
    const { service, config } = setup();
    const first = value(service.create({ target: MR, repository: 'pages' }));
    expect(service.create({ target: `${MR}/diffs`, repository: 'pages' })).toEqual({
      ok: false,
      error: {
        code: 'DUPLICATE_WATCH',
        existing: { id: first.id, state: 'active', intervalMs: config.schedule.intervals.mr },
      },
    });
    expect(value(service.create({ target: MR, repository: 'api' })).id).not.toBe(first.id);
  });

  test('create sets active, next_check_at now, title default target', () => {
    const { service, clock } = setup();
    const w = value(
      service.create({
        target: `${MR}/diffs`,
        repository: 'pages',
        model: 'gpt-x',
        initialReview: 'unresolved',
        intervalMs: 60_000,
      }),
    );
    expect(w).toMatchObject({
      kind: 'mr',
      targetUrl: MR,
      normalizedTarget: 'gitlab:gitlab.example.com/team/app!42',
      repository: 'pages',
      title: MR,
      state: 'active',
      instructions: null,
      intervalMs: 60_000,
      model: 'gpt-x',
      initialReview: 'unresolved',
      cursor: null,
      nextCheckAt: clock.now(),
      checkFailures: 0,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    expect(value(service.create({ target: 'ABC-1', repository: 'pages', title: 'Fix login' })).title).toBe('Fix login');
    expect(service.get(w.id)).toEqual(w);
    expect(service.get(999)).toBeNull();
  });

  test('index backstop maps unique violation to DUPLICATE_WATCH', () => {
    const { db, service, config } = setup();
    const existing = insertWatch(db, { normalizedTarget: 'gitlab:gitlab.example.com/team/app!42', repository: 'pages' });
    // Blind the friendly pre-check (first lookup only) so the unique index catches the duplicate, as in a race.
    const prepare = db.prepare.bind(db);
    let blinded = false;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (blinded || !sql.includes("AND state <> 'closed'")) return prepare(sql);
      blinded = true;
      return prepare(sql.replace("AND state <> 'closed'", "AND state <> 'closed' AND 0"));
    });
    const r = service.create({ target: MR, repository: 'pages' });
    spy.mockRestore();
    expect(blinded).toBe(true);
    expect(r).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_WATCH', existing: { id: existing, state: 'active', intervalMs: config.schedule.intervals.mr } },
    });
    expect(count(db, 'watches')).toBe(1);
  });
});

describe('WatchService.list', () => {
  test('list filters by state and repository', () => {
    const { db, service } = setup();
    const a = insertWatch(db, { state: 'active', repository: 'pages' });
    const b = insertWatch(db, { state: 'paused', repository: 'pages' });
    const c = insertWatch(db, { state: 'active', repository: 'api' });
    expect(service.list().map((w) => w.id)).toEqual([a, b, c]);
    expect(service.list({ state: 'active' }).map((w) => w.id)).toEqual([a, c]);
    expect(service.list({ state: 'active', repository: 'api' }).map((w) => w.id)).toEqual([c]);
  });
});

describe('WatchService.update', () => {
  test('update cannot change target or repository', () => {
    const { service, clock } = setup();
    const w = value(service.create({ target: MR, repository: 'pages', instructions: 'a', model: 'm1' }));
    clock.advance(1000);
    const u = value(service.update(w.id, { intervalMs: 120_000, instructions: 'b', initialReview: 'unresolved' }));
    expect(u).toMatchObject({
      targetUrl: w.targetUrl,
      normalizedTarget: w.normalizedTarget,
      repository: 'pages',
      intervalMs: 120_000,
      instructions: 'b',
      model: 'm1',
      initialReview: 'unresolved',
      updatedAt: clock.now(),
    });
    const cleared = value(service.update(w.id, { intervalMs: null, model: null, instructions: null, initialReview: null }));
    expect(cleared).toMatchObject({ intervalMs: null, model: null, instructions: null, initialReview: null });
    expect(service.update(w.id, { intervalMs: 0 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'intervalMs' },
    });
    expect(service.update(999, {})).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('update cannot clear free-form instructions', () => {
    const { service } = setup();
    const w = value(service.create({ target: 'https://example.com/doc', repository: 'pages', instructions: 'x' }));
    const missing = { ok: false, error: { code: 'MISSING_INSTRUCTIONS' } };
    expect(service.update(w.id, { instructions: null })).toEqual(missing);
    expect(service.update(w.id, { instructions: ' ' })).toEqual(missing);
    expect(service.get(w.id)?.instructions).toBe('x');
  });
});

describe('WatchService state actions', () => {
  test('pause and close clear next_check_at; close removes queued row and sets closed_reason user and closed_at', () => {
    const { db, service, clock } = setup();
    const a = value(service.create({ target: MR, repository: 'pages' }));
    clock.advance(1000);
    expect(value(service.pause(a.id))).toMatchObject({ state: 'paused', nextCheckAt: null, updatedAt: clock.now() });
    expect(service.pause(a.id)).toEqual({ ok: false, error: { code: 'INVALID_STATE', state: 'paused', action: 'pause' } });

    value(service.runNow(a.id, {}));
    expect(queued(db)).toHaveLength(1);
    clock.advance(1000);
    expect(value(service.close(a.id))).toMatchObject({
      state: 'closed',
      nextCheckAt: null,
      closedReason: 'user',
      closedAt: clock.now(),
      updatedAt: clock.now(),
    });
    expect(queued(db)).toHaveLength(0);
    expect(service.close(a.id)).toEqual({ ok: false, error: { code: 'INVALID_STATE', state: 'closed', action: 'close' } });
    expect(service.pause(999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('reopen keeps cursor', () => {
    const { db, service, clock } = setup();
    const w = value(service.create({ target: MR, repository: 'pages' }));
    const cursor = { lastNoteId: 7, handledPipelineId: null, handledConflictSha: null };
    db.prepare('UPDATE watches SET cursor_json = ? WHERE id = ?').run(JSON.stringify(cursor), w.id);
    value(service.close(w.id));
    clock.advance(5000);
    expect(value(service.reopen(w.id))).toMatchObject({
      state: 'active',
      cursor,
      nextCheckAt: clock.now(),
      closedReason: null,
      closedAt: null,
    });
    expect(service.reopen(w.id)).toEqual({ ok: false, error: { code: 'INVALID_STATE', state: 'active', action: 'reopen' } });
  });

  test('reopen into duplicate is DUPLICATE_WATCH', () => {
    const { service } = setup();
    const old = value(service.create({ target: MR, repository: 'pages' }));
    value(service.close(old.id));
    const fresh = value(service.create({ target: MR, repository: 'pages', intervalMs: 60_000 }));
    expect(service.reopen(old.id)).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_WATCH', existing: { id: fresh.id, state: 'active', intervalMs: 60_000 } },
    });
    expect(service.get(old.id)?.state).toBe('closed');
  });

  test("resume clears needs_you fields, stores note, sets next_check_at now; runNow variant enqueues manual run with reason 'Resume & run now'", () => {
    const { db, service, clock, config } = setup();
    const w = value(service.create({ target: MR, repository: 'pages' }));
    const enterNeedsYou = () =>
      db
        .prepare(
          `UPDATE watches SET state = 'needs_you', next_check_at = NULL, needs_you_reason = 'conflict',
           needs_you_since = 1, check_failures = 3 WHERE id = ?`,
        )
        .run(w.id);
    enterNeedsYou();
    clock.advance(1000);
    expect(value(service.resume(w.id, { note: 'rebased' }))).toMatchObject({
      state: 'active',
      needsYouReason: null,
      needsYouSince: null,
      needsYouRunId: null,
      checkFailures: 0,
      resolutionNote: 'rebased',
      nextCheckAt: clock.now(),
    });
    expect(queued(db)).toHaveLength(0);
    expect(service.resume(w.id, {})).toEqual({ ok: false, error: { code: 'INVALID_STATE', state: 'active', action: 'resume' } });

    enterNeedsYou();
    expect(value(service.resume(w.id, { runNow: true }))).toMatchObject({ state: 'active', needsYouReason: null });
    expect(queued(db)).toEqual([
      {
        watch_id: w.id,
        trigger: 'manual',
        reason: 'Resume & run now',
        model: config.runs.defaultModel,
        extra_instructions: null,
        review_unresolved: 0,
      },
    ]);

    value(service.pause(w.id));
    expect(service.resume(w.id, { runNow: true })).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'paused', action: 'resumeRunNow' },
    });
    expect(value(service.resume(w.id, {}))).toMatchObject({ state: 'active', nextCheckAt: clock.now() });
  });

  test('runNow on paused enqueues and keeps paused', () => {
    const { db, service } = setup();
    const w = value(service.create({ target: MR, repository: 'pages', model: 'watch-model' }));
    value(service.pause(w.id));
    const run = value(service.runNow(w.id, { extraInstructions: 'check tests', reviewUnresolved: true }));
    expect(run).toMatchObject({
      watchId: w.id,
      repository: 'pages',
      status: 'queued',
      trigger: 'manual',
      priority: 0,
      reason: 'Run now',
      model: 'watch-model',
      extraInstructions: 'check tests',
      reviewUnresolved: true,
    });
    expect(service.get(w.id)).toMatchObject({ state: 'paused', nextCheckAt: null });
    expect(queued(db)).toHaveLength(1);
  });

  test('runNow on needs_you is INVALID_STATE', () => {
    const { db, service } = setup();
    const id = insertWatch(db, { state: 'needs_you' });
    expect(service.runNow(id, {})).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', state: 'needs_you', action: 'runNow' },
    });
    expect(service.runNow(999, {})).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(queued(db)).toHaveLength(0);
  });

  test('runNow on jira watch with jira disabled is JIRA_DISABLED', () => {
    const { db, service } = setup();
    const w = value(service.create({ target: 'ABC-1', repository: 'pages' }));
    expect(service.runNow(w.id, {})).toEqual({ ok: false, error: { code: 'JIRA_DISABLED' } });
    expect(queued(db)).toHaveLength(0);

    const enabled = setup({ config: testConfig({ jira: { enabled: true } }) });
    const j = value(enabled.service.create({ target: 'ABC-1', repository: 'pages' }));
    expect(value(enabled.service.runNow(j.id, {})).trigger).toBe('manual');
  });

  test('resume & run now on jira watch with jira disabled is JIRA_DISABLED and leaves state unchanged', () => {
    const { db, service } = setup();
    const id = insertWatch(db, { kind: 'jira', normalizedTarget: 'jira:jira.example.com/ABC-1', state: 'needs_you' });
    const before = service.get(id);
    expect(service.resume(id, { runNow: true, note: 'x' })).toEqual({ ok: false, error: { code: 'JIRA_DISABLED' } });
    expect(service.get(id)).toEqual(before);
    expect(queued(db)).toHaveLength(0);
    expect(value(service.resume(id, {}))).toMatchObject({ state: 'active' });
  });

  test('delete while running is RUN_IN_PROGRESS', () => {
    const { db, service, queue } = setup();
    const w = value(service.create({ target: MR, repository: 'pages' }));
    value(service.runNow(w.id, {}));
    const running = queue.claimNext()!;
    expect(service.delete(w.id)).toEqual({ ok: false, error: { code: 'RUN_IN_PROGRESS', runId: running.id } });
    expect(service.get(w.id)).not.toBeNull();
    expect(count(db, 'runs')).toBe(1);
  });

  test('delete removes watch and its run dirs', () => {
    const { db, service, queue, dataDir } = setup();
    const w = value(service.create({ target: MR, repository: 'pages' }));
    const other = value(service.create({ target: 'https://gitlab.example.com/team/app/-/merge_requests/43', repository: 'pages' }));
    const finished = value(service.runNow(w.id, {}));
    queue.claimNext();
    db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(finished.id);
    const pending = value(service.runNow(w.id, {}));
    const otherRun = value(service.runNow(other.id, {}));
    for (const id of [finished.id, pending.id, otherRun.id]) {
      fs.writeFileSync(path.join(dataDir.ensureRunDir(id), 'cli.log'), 'x');
    }
    const insertEvent = db.prepare(
      "INSERT INTO needs_you_events (watch_id, reason, created_at, teams_status) VALUES (?, 'r', 0, 'sent') RETURNING id",
    );
    const eventOf = (watchId: number) => (insertEvent.get(watchId) as { id: number }).id;
    const [deletedEvent, otherEvent] = [eventOf(w.id), eventOf(other.id)];
    fs.mkdirSync(dataDir.notifyDir, { recursive: true });
    for (const id of [deletedEvent, otherEvent]) {
      for (const file of [dataDir.notifyTranscriptPath(id), dataDir.notifyLogPath(id)]) fs.writeFileSync(file, 'x');
    }

    expect(service.delete(w.id)).toEqual({ ok: true, value: undefined });
    expect(fs.readdirSync(dataDir.notifyDir).sort()).toEqual([`${otherEvent}.log`, `${otherEvent}.md`]);
    expect(service.get(w.id)).toBeNull();
    expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: otherRun.id }]);
    expect(fs.existsSync(dataDir.runDir(finished.id))).toBe(false);
    expect(fs.existsSync(dataDir.runDir(pending.id))).toBe(false);
    expect(fs.existsSync(dataDir.runDir(otherRun.id))).toBe(true);
    expect(service.delete(w.id)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('WatchService.previewTarget', () => {
  const preview: TargetPreview = { title: 'Add login', state: 'opened', sourceBranch: 'feat/login' };

  test('returns kind and preview', async () => {
    const calls: unknown[] = [];
    const { service } = setup({
      preview: async (t, repository) => {
        calls.push([t.normalizedTarget, repository]);
        return preview;
      },
    });
    expect(await service.previewTarget(MR, 'pages')).toEqual({ kind: 'mr', preview });
    expect(calls).toEqual([['gitlab:gitlab.example.com/team/app!42', 'pages']]);
  });

  test('previewTarget returns kind only with reason when preview fails', async () => {
    const failing = setup({
      preview: async () => {
        throw new Error('GitLab 401');
      },
    });
    expect(await failing.service.previewTarget(MR, 'pages')).toEqual({
      kind: 'mr',
      preview: null,
      previewError: 'GitLab 401',
    });
    const absent = setup();
    expect(await absent.service.previewTarget(MR, 'pages')).toEqual({
      kind: 'mr',
      preview: null,
      previewError: 'Preview unavailable',
    });
    expect(await absent.service.previewTarget('nope', 'pages')).toEqual({
      kind: null,
      preview: null,
      error: { code: 'INVALID_TARGET', message: 'Not a URL or Jira key: nope' },
    });
  });
});
