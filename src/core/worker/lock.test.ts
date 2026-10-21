import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { tempDb } from '../../../test/helpers/db';
import type { Database } from '../db/open';
import { acquireWorkerLock, heartbeat, releaseWorkerLock } from './lock';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  return { db: t.db, clock: fakeClock() };
}

const lockRow = (db: Database) =>
  db.prepare('SELECT pid, started_at, heartbeat_at FROM worker_lock').get() as
    | { pid: number; started_at: number; heartbeat_at: number }
    | undefined;

const alive = () => true;

describe('worker lock', () => {
  test('second live worker is rejected with WORKER_RUNNING', () => {
    const { db, clock } = setup();
    expect(acquireWorkerLock(db, clock, 100, alive)).toEqual({ ok: true, value: undefined });
    clock.advance(5_000);
    heartbeat(db, clock, 100);
    clock.advance(14_000);
    expect(acquireWorkerLock(db, clock, 200, alive)).toEqual({ ok: false, error: { code: 'WORKER_RUNNING', pid: 100 } });
    expect(lockRow(db)?.pid).toBe(100);
  });

  test('stale heartbeat (16 s) is taken over', () => {
    const { db, clock } = setup();
    acquireWorkerLock(db, clock, 100, alive);
    clock.advance(16_000);
    expect(acquireWorkerLock(db, clock, 200, alive).ok).toBe(true);
    expect(lockRow(db)).toEqual({ pid: 200, started_at: clock.now(), heartbeat_at: clock.now() });
  });

  test('dead pid is taken over', () => {
    const { db, clock } = setup();
    acquireWorkerLock(db, clock, 100, alive);
    clock.advance(1_000);
    const checked: number[] = [];
    const result = acquireWorkerLock(db, clock, 200, (pid) => {
      checked.push(pid);
      return false;
    });
    expect(result.ok).toBe(true);
    expect(checked).toEqual([100]);
    expect(lockRow(db)?.pid).toBe(200);
  });

  test('release clears row', () => {
    const { db, clock } = setup();
    acquireWorkerLock(db, clock, 100, alive);
    releaseWorkerLock(db, 200);
    expect(lockRow(db)?.pid).toBe(100);
    releaseWorkerLock(db, 100);
    expect(lockRow(db)).toBeUndefined();
  });

  test('heartbeat updates only the owning pid', () => {
    const { db, clock } = setup();
    acquireWorkerLock(db, clock, 100, alive);
    const startedAt = clock.now();
    clock.advance(3_000);
    heartbeat(db, clock, 200);
    expect(lockRow(db)?.heartbeat_at).toBe(startedAt);
    heartbeat(db, clock, 100);
    expect(lockRow(db)).toEqual({ pid: 100, started_at: startedAt, heartbeat_at: clock.now() });
  });
});
