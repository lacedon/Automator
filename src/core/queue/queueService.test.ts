import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import type { Database } from '../db/open';
import { DataDir } from '../files/dataDir';
import { QueueService } from './queueService';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const dataDir = new DataDir(path.dirname(t.file));
  return { db: t.db, file: t.file, clock, dataDir, queue: new QueueService(t.db, clock, dataDir) };
}

function statuses(db: Database): { id: number; status: string }[] {
  return db.prepare('SELECT id, status FROM runs ORDER BY id').all() as { id: number; status: string }[];
}

const base = { repository: 'pages', model: 'm' };

describe('QueueService', () => {
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

  test('merges second trigger into existing queued row', () => {
    const { db, clock, queue } = setup();
    const w = insertWatch(db);
    const first = queue.enqueueWatch({ ...base, watchId: w, trigger: 'schedule', reason: 'r1' });
    clock.advance(1000);
    queue.enqueueWatch({ ...base, watchId: w, trigger: 'manual', reason: 'r2', extraInstructions: 'A', reviewUnresolved: true });
    clock.advance(1000);
    const merged = queue.enqueueWatch({ ...base, watchId: w, trigger: 'manual', reason: 'r3', extraInstructions: 'A\n\nB' });

    expect(statuses(db)).toHaveLength(1);
    expect(merged).toMatchObject({
      id: first.id,
      priority: 0,
      trigger: 'manual',
      extraInstructions: 'A\n\nB',
      reviewUnresolved: true,
      reason: 'r1; r2; r3',
      queuedAt: first.queuedAt,
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
});
