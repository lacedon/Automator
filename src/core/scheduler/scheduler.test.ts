import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig, type DeepPartial } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toRun, toWatch } from '../db/rows';
import type { NeedsYouEvent, Watch, WatchKind } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { FreeformPrecheck } from '../prechecks/freeform';
import type { Prechecks } from '../prechecks/index';
import type { JiraPrecheck } from '../prechecks/jira';
import type { Precheck, PrecheckResult } from '../prechecks/types';
import { QueueService } from '../queue/queueService';
import { Scheduler } from './scheduler';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MIN = 60_000;

type Script = (w: Watch) => PrecheckResult;

function stubPrecheck(script: Script) {
  const calls: number[] = [];
  const precheck: Precheck = {
    check: async (w) => {
      calls.push(w.id);
      return script(w);
    },
    snapshot: () => Promise.reject(new Error('not used')),
  };
  return { precheck, calls };
}

function setup(opts: { configOverrides?: DeepPartial<Config>; script?: Script; jiraHasToken?: boolean } = {}) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const config = testConfig(opts.configOverrides);
  const queue = new QueueService(t.db, clock, new DataDir(path.dirname(t.file)));
  const script = opts.script ?? (() => ({ kind: 'unchanged' }));
  const mr = stubPrecheck(script);
  const jira = stubPrecheck(script);
  const prechecks: Prechecks = {
    mr: mr.precheck,
    jira: { ...jira.precheck, hasToken: () => opts.jiraHasToken ?? true } as unknown as JiraPrecheck,
    free: new FreeformPrecheck(),
  };
  const events: NeedsYouEvent[] = [];
  const onNeedsYou = vi.fn((e: NeedsYouEvent): void | Promise<void> => {
    events.push(e);
  });
  const scheduler = new Scheduler({ db: t.db, clock, config, queue, prechecks, onNeedsYou });
  return { db: t.db, clock, config, scheduler, mrCalls: mr.calls, jiraCalls: jira.calls, events, onNeedsYou };
}

function dueWatch(db: Database, nextCheckAt: number, kind: WatchKind = 'mr', state: Watch['state'] = 'active'): number {
  const id = insertWatch(db, { kind, state });
  db.prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(nextCheckAt, id);
  return id;
}

function watch(db: Database, id: number): Watch {
  return toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));
}

function runsOf(db: Database, watchId: number) {
  return db.prepare('SELECT * FROM runs WHERE watch_id = ? ORDER BY id').all(watchId).map(toRun);
}

describe('Scheduler.tick', () => {
  test('does nothing outside working hours', async () => {
    const { db, clock, scheduler, mrCalls } = setup();
    const saturday = Date.parse('2026-10-24T10:00:00');
    clock.set(saturday);
    const id = dueWatch(db, saturday - MIN);
    expect(await scheduler.tick()).toEqual({ checked: 0, enqueued: 0 });
    clock.set(Date.parse('2026-10-21T19:30:00'));
    expect(await scheduler.tick()).toEqual({ checked: 0, enqueued: 0 });
    expect(mrCalls).toEqual([]);
    expect(watch(db, id).nextCheckAt).toBe(saturday - MIN);
  });

  test('checks only due active watches without queued or running runs, oldest first', async () => {
    const { db, clock, scheduler, mrCalls } = setup();
    const now = clock.now();
    const recent = dueWatch(db, now - MIN);
    const oldest = dueWatch(db, now - 5 * MIN);
    const exactlyNow = dueWatch(db, now);
    dueWatch(db, now + MIN);
    dueWatch(db, now - MIN, 'mr', 'paused');
    dueWatch(db, now - MIN, 'mr', 'needs_you');
    const withQueued = dueWatch(db, now - MIN);
    const withRunning = dueWatch(db, now - MIN);
    db.prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
       VALUES (?, 'pages', 'queued', 'manual', 0, 'r', 'm', ?), (?, 'pages', 'running', 'manual', 0, 'r', 'm', ?)`,
    ).run(withQueued, now, withRunning, now);

    expect(await scheduler.tick()).toEqual({ checked: 3, enqueued: 0 });
    expect(mrCalls).toEqual([oldest, recent, exactlyNow]);
  });

  test('changed enqueues scheduled run with reason and resets failures', async () => {
    const { db, clock, config, scheduler } = setup({ script: () => ({ kind: 'changed', reason: '2 new notes' }) });
    const id = dueWatch(db, clock.now() - MIN);
    const withModel = dueWatch(db, clock.now() - MIN);
    db.prepare('UPDATE watches SET check_failures = 2 WHERE id = ?').run(id);
    db.prepare("UPDATE watches SET model = 'gpt-x' WHERE id = ?").run(withModel);

    expect(await scheduler.tick()).toEqual({ checked: 2, enqueued: 2 });
    expect(runsOf(db, id)).toMatchObject([
      {
        status: 'queued',
        trigger: 'schedule',
        priority: 1,
        reason: '2 new notes',
        model: config.runs.defaultModel,
        repository: 'pages',
      },
    ]);
    expect(runsOf(db, withModel)).toMatchObject([{ model: 'gpt-x' }]);
    expect(watch(db, id).checkFailures).toBe(0);
  });

  test('unchanged stores baseline cursor', async () => {
    const cursor = { lastNoteId: 42, handledPipelineId: null, handledConflictSha: null };
    const kept = { lastNoteId: 7, handledPipelineId: null, handledConflictSha: null };
    const { db, clock, scheduler } = setup({
      script: (w) => (w.title.endsWith('-keep') ? { kind: 'unchanged' } : { kind: 'unchanged', cursor }),
    });
    const id = dueWatch(db, clock.now() - MIN);
    db.prepare('UPDATE watches SET check_failures = 1 WHERE id = ?').run(id);
    const keep = dueWatch(db, clock.now() - MIN);
    db.prepare("UPDATE watches SET title = title || '-keep', cursor_json = ? WHERE id = ?").run(JSON.stringify(kept), keep);

    expect(await scheduler.tick()).toEqual({ checked: 2, enqueued: 0 });
    expect(watch(db, id)).toMatchObject({ cursor, checkFailures: 0 });
    expect(watch(db, keep).cursor).toEqual(kept);
    expect(runsOf(db, id)).toEqual([]);
  });

  test('close result closes watch with reason', async () => {
    const { db, clock, scheduler } = setup({ script: () => ({ kind: 'close', reason: 'merged' }) });
    const id = dueWatch(db, clock.now() - MIN);
    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 0 });
    expect(watch(db, id)).toMatchObject({ state: 'closed', closedReason: 'merged', closedAt: clock.now(), nextCheckAt: null });
    expect(runsOf(db, id)).toEqual([]);
  });

  test('auth failure moves to needs_you immediately and calls onNeedsYou', async () => {
    const { db, clock, scheduler, events } = setup({
      configOverrides: { teams: { chatId: 'chat-1' } },
      script: () => ({ kind: 'failed', auth: true, message: 'GitLab token rejected (401)' }),
    });
    const id = dueWatch(db, clock.now() - MIN);
    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 0 });
    expect(watch(db, id)).toMatchObject({
      state: 'needs_you',
      needsYouReason: 'GitLab token rejected (401)',
      needsYouSince: clock.now(),
      needsYouRunId: null,
      nextCheckAt: null,
    });
    expect(events).toMatchObject([
      { watchId: id, runId: null, reason: 'GitLab token rejected (401)', teamsStatus: 'pending' },
    ]);
  });

  test('third consecutive non-auth failure moves to needs_you; second does not', async () => {
    let n = 0;
    const { db, clock, config, scheduler, events } = setup({
      script: () => ({ kind: 'failed', auth: false, message: `timeout ${++n}` }),
    });
    const id = dueWatch(db, clock.now() - MIN);
    const interval = config.schedule.intervals.mr;

    await scheduler.tick();
    clock.advance(interval);
    await scheduler.tick();
    expect(watch(db, id)).toMatchObject({ state: 'active', checkFailures: 2, nextCheckAt: clock.now() + interval });
    expect(events).toEqual([]);

    clock.advance(interval);
    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 0 });
    expect(watch(db, id)).toMatchObject({
      state: 'needs_you',
      needsYouReason: 'Pre-check failed 3 times: timeout 3',
      nextCheckAt: null,
    });
    expect(events).toMatchObject([
      { watchId: id, reason: 'Pre-check failed 3 times: timeout 3', teamsStatus: 'disabled' },
    ]);
  });

  test('jira watches skipped when jira disabled', async () => {
    const { db, clock, scheduler, jiraCalls } = setup();
    const id = dueWatch(db, clock.now() - MIN, 'jira');
    expect(await scheduler.tick()).toEqual({ checked: 0, enqueued: 0 });
    expect(jiraCalls).toEqual([]);
    expect(watch(db, id).nextCheckAt).toBe(clock.now() - MIN);
  });

  test('jira without token enqueues without calling check', async () => {
    const { db, clock, config, scheduler, jiraCalls } = setup({
      configOverrides: { jira: { enabled: true } },
      jiraHasToken: false,
    });
    const id = dueWatch(db, clock.now() - MIN, 'jira');
    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 1 });
    expect(jiraCalls).toEqual([]);
    expect(runsOf(db, id)).toMatchObject([{ trigger: 'schedule', reason: 'interval' }]);
    expect(watch(db, id).nextCheckAt).toBe(clock.now() + config.schedule.intervals.default);
  });

  test('free-form enqueues every interval', async () => {
    const { db, clock, config, scheduler } = setup();
    const id = dueWatch(db, clock.now(), 'free');
    const interval = config.schedule.intervals.default;

    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 1 });
    db.prepare("UPDATE runs SET status = 'finished' WHERE watch_id = ?").run(id);
    clock.advance(interval - 1);
    expect(await scheduler.tick()).toEqual({ checked: 0, enqueued: 0 });
    clock.advance(1);
    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 1 });
    expect(runsOf(db, id)).toMatchObject([
      { status: 'finished', reason: 'interval' },
      { status: 'queued', trigger: 'schedule', reason: 'interval' },
    ]);
  });

  test('sets next_check_at to now + interval after each check (missed intervals not replayed)', async () => {
    const { db, clock, config, scheduler } = setup({ script: () => ({ kind: 'changed', reason: 'new note' }) });
    const interval = config.schedule.intervals.mr;
    const id = dueWatch(db, clock.now() - 5 * interval);

    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 1 });
    expect(watch(db, id).nextCheckAt).toBe(clock.now() + interval);
    db.prepare("UPDATE runs SET status = 'finished' WHERE watch_id = ?").run(id);
    expect(await scheduler.tick()).toEqual({ checked: 0, enqueued: 0 });
    expect(runsOf(db, id)).toHaveLength(1);
  });

  test('applies nothing when the watch left active during the check', async () => {
    const holder: { db?: Database } = {};
    const s = setup({
      script: (w) => {
        holder.db!.prepare("UPDATE watches SET state = 'paused', next_check_at = NULL WHERE id = ?").run(w.id);
        return { kind: 'changed', reason: 'new note' };
      },
    });
    const db = (holder.db = s.db);
    const id = dueWatch(db, s.clock.now() - MIN);
    expect(await s.scheduler.tick()).toEqual({ checked: 1, enqueued: 0 });
    expect(watch(db, id)).toMatchObject({ state: 'paused', nextCheckAt: null });
    expect(runsOf(db, id)).toEqual([]);
  });

  test('ignores onNeedsYou rejections', async () => {
    const { db, clock, scheduler, onNeedsYou } = setup({
      script: () => ({ kind: 'failed', auth: true, message: 'denied' }),
    });
    onNeedsYou.mockImplementation(() => Promise.reject(new Error('teams down')));
    const id = dueWatch(db, clock.now() - MIN);
    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(watch(db, id).state).toBe('needs_you');
    expect(onNeedsYou).toHaveBeenCalledOnce();
  });

  test('continues with other watches when one apply throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids: { applyThrows?: number; checkThrows?: number } = {};
    const good = { lastNoteId: 5, handledPipelineId: null, handledConflictSha: null };
    const { db, clock, config, scheduler } = setup({
      script: (w) => {
        if (w.id === ids.checkThrows) throw new Error('check exploded');
        // A BigInt in the cursor makes JSON.stringify throw inside apply.
        if (w.id === ids.applyThrows) return { kind: 'unchanged', cursor: { lastNoteId: 1n } as unknown as typeof good };
        return { kind: 'unchanged', cursor: good };
      },
    });
    const interval = config.schedule.intervals.mr;
    ids.applyThrows = dueWatch(db, clock.now() - 3 * MIN);
    ids.checkThrows = dueWatch(db, clock.now() - 2 * MIN);
    const ok = dueWatch(db, clock.now() - MIN);

    expect(await scheduler.tick()).toEqual({ checked: 1, enqueued: 0 });
    expect(watch(db, ok).cursor).toEqual(good);
    for (const id of [ids.applyThrows, ids.checkThrows]) {
      expect(watch(db, id)).toMatchObject({ state: 'active', nextCheckAt: clock.now() + interval, cursor: null });
    }
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\S+Z .*Watch #${ids.checkThrows}.*check exploded`)));
    errors.mockRestore();
  });
});
