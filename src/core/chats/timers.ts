import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toChatSession } from '../db/rows';
import { isWithinWorkingHours, nextWindowStart } from '../domain/schedule';
import type { Clock, PendingTimer } from '../domain/types';
import type { QueueService } from '../queue/queueService';

// The one Automator timer of an Interactive Chat lives in chat_sessions.timer_*; the scheduler fires it.

type WorkingHours = Config['schedule']['workingHours'];

export function timerPrompt(timer: PendingTimer): string {
  return `Scheduled wake-up (set ${new Date(timer.createdAt).toISOString()}):\n\n${timer.message}`;
}

// A session that is closed or being closed takes no timer.
export function setTimer(db: Database, sessionId: number, timer: PendingTimer): { replaced: PendingTimer | null } {
  return db
    .transaction((): { replaced: PendingTimer | null } => {
      const row = db
        .prepare('SELECT * FROM chat_sessions WHERE id = ? AND closed_at IS NULL AND close_requested_at IS NULL')
        .get(sessionId);
      if (row === undefined) return { replaced: null };
      const replaced = toChatSession(row).timer;
      db.prepare(
        'UPDATE chat_sessions SET timer_fire_at = ?, timer_message = ?, timer_created_at = ? WHERE id = ?',
      ).run(timer.fireAt, timer.message, timer.createdAt, sessionId);
      return { replaced };
    })
    .immediate();
}

export function cancelTimer(db: Database, sessionId: number): boolean {
  return (
    db
      .prepare(
        `UPDATE chat_sessions SET timer_fire_at = NULL, timer_message = NULL, timer_created_at = NULL
         WHERE id = ? AND timer_fire_at IS NOT NULL`,
      )
      .run(sessionId).changes > 0
  );
}

// Earliest instant >= fireAt inside the working hours. Hours that define no window cannot fire: fireAt is returned.
export function nextFiringTime(fireAt: number, workingHours: WorkingHours): number {
  if (isWithinWorkingHours(fireAt, workingHours)) return fireAt;
  try {
    return nextWindowStart(fireAt, workingHours);
  } catch {
    return fireAt;
  }
}

// Enqueues one `timer` Run per due, open Chat whose tip is finished and that has no queued or running turn and no
// close request, and clears the timer in the same IMMEDIATE transaction (so concurrent ticks cannot enqueue twice).
// A pending question does not block a timer. Returns the ids of the Runs enqueued.
export function fireDueChatTimers(deps: {
  db: Database;
  clock: Clock;
  queue: QueueService;
  configFor: ConfigFor;
}): number[] {
  const { db, clock, queue } = deps;
  const due = (now: number) =>
    db
      .prepare(
        `SELECT id FROM chat_sessions
         WHERE timer_fire_at IS NOT NULL AND timer_fire_at <= ? AND closed_at IS NULL AND close_requested_at IS NULL
         ORDER BY timer_fire_at, id`,
      )
      .all(now) as { id: number }[];
  // Cheap read-only pre-check: most ticks have nothing due and must not take a write lock.
  if (due(clock.now()).length === 0) return [];
  return db
    .transaction((): number[] => {
      const now = clock.now();
      const enqueued: number[] = [];
      for (const { id } of due(now)) {
        const session = toChatSession(db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id));
        const timer = session.timer;
        if (timer === null) continue;
        if (!isWithinWorkingHours(now, deps.configFor(session.repository).schedule.workingHours)) continue;
        const busy = db
          .prepare("SELECT 1 FROM runs WHERE chat_session_id = ? AND status IN ('queued', 'running')")
          .get(id);
        if (busy !== undefined) continue;
        const tip = db
          .prepare(
            `SELECT id, status FROM runs r WHERE r.chat_session_id = ?
               AND NOT EXISTS (SELECT 1 FROM runs c WHERE c.parent_run_id = r.id)
             ORDER BY r.id DESC LIMIT 1`,
          )
          .get(id) as { id: number; status: string } | undefined;
        if (tip === undefined || tip.status !== 'finished') continue;
        const run = queue.enqueueAdhoc({
          repository: session.repository,
          prompt: timerPrompt(timer),
          provider: session.provider,
          model: session.model,
          parentRunId: tip.id,
          agentId: session.agentId,
          chatSessionId: id,
          trigger: 'timer',
        });
        db.prepare('UPDATE runs SET owner_user_id = (SELECT owner_user_id FROM runs WHERE id = ?) WHERE id = ?').run(
          tip.id,
          run.id,
        );
        cancelTimer(db, id);
        enqueued.push(run.id);
      }
      return enqueued;
    })
    .immediate();
}
