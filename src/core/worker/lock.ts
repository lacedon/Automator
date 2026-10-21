import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';
import type { Clock } from '../domain/types';

const STALE_MS = 15_000;

export type WorkerRunning = { code: 'WORKER_RUNNING'; pid: number };

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireWorkerLock(
  db: Database,
  clock: Clock,
  pid: number,
  isAlive: (pid: number) => boolean,
): Result<void, WorkerRunning> {
  return db
    .transaction((): Result<void, WorkerRunning> => {
      const now = clock.now();
      const row = db.prepare('SELECT pid, heartbeat_at FROM worker_lock WHERE id = 1').get() as
        | { pid: number; heartbeat_at: number }
        | undefined;
      if (row !== undefined && row.pid !== pid && now - row.heartbeat_at < STALE_MS && isAlive(row.pid)) {
        return err({ code: 'WORKER_RUNNING', pid: row.pid });
      }
      db.prepare(
        `INSERT INTO worker_lock (id, pid, started_at, heartbeat_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
      ).run(pid, now, now);
      return ok(undefined);
    })
    .immediate();
}

export function heartbeat(db: Database, clock: Clock, pid: number): void {
  db.prepare('UPDATE worker_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?').run(clock.now(), pid);
}

export function releaseWorkerLock(db: Database, pid: number): void {
  db.prepare('DELETE FROM worker_lock WHERE id = 1 AND pid = ?').run(pid);
}
