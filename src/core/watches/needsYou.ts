import type { Database } from '../db/open';
import type { ClosedReason } from '../domain/types';

export function closeWatch(db: Database, watchId: number, reason: ClosedReason, now: number): void {
  db.prepare(
    `UPDATE watches SET state = 'closed', closed_reason = ?, closed_at = ?, next_check_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(reason, now, now, watchId);
  db.prepare("DELETE FROM runs WHERE watch_id = ? AND status = 'queued'").run(watchId);
}
