import type { Database } from '../db/open';
import { toNeedsYouEvent } from '../db/rows';
import type { ClosedReason, NeedsYouEvent } from '../domain/types';

export interface EnterNeedsYouInput {
  watchId: number;
  runId: number | null;
  reason: string;
  now: number;
  teamsEnabled: boolean;
}

export function enterNeedsYou(db: Database, input: EnterNeedsYouInput): NeedsYouEvent | null {
  const { watchId, runId, reason, now, teamsEnabled } = input;
  const updated = db
    .prepare(
      `UPDATE watches SET state = 'needs_you', needs_you_reason = ?, needs_you_since = ?, needs_you_run_id = ?,
              next_check_at = NULL, updated_at = ?
       WHERE id = ? AND state <> 'closed'`,
    )
    .run(reason, now, runId, now, watchId);
  if (updated.changes === 0) return null;
  return toNeedsYouEvent(
    db
      .prepare(
        `INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(watchId, runId, reason, now, teamsEnabled ? 'pending' : 'disabled'),
  );
}

export function closeWatch(db: Database, watchId: number, reason: ClosedReason, now: number): void {
  db.prepare(
    `UPDATE watches SET state = 'closed', closed_reason = ?, closed_at = ?, next_check_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(reason, now, now, watchId);
  db.prepare("DELETE FROM runs WHERE watch_id = ? AND status = 'queued'").run(watchId);
}
