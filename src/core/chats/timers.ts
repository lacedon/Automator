import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toChatSession } from '../db/rows';
import { isWithinWorkingHours, nextWindowStart } from '../domain/schedule';
import type { Clock, PendingTimer, ProviderName } from '../domain/types';
import { interactiveSupport } from './capabilities';
import type { QueueService } from '../queue/queueService';

// The one Automator timer of an Interactive Chat lives in chat_sessions.timer_*; the scheduler fires it.

type WorkingHours = Config['schedule']['workingHours'];

const PROMPT_HEADER = /^Scheduled wake-up \(set [^)\n]*\):\n\n/;

export function timerPrompt(timer: PendingTimer): string {
  return `Scheduled wake-up (set ${new Date(timer.createdAt).toISOString()}):\n\n${timer.message}`;
}

// The agent's own message out of a stored timer prompt (what the thread shows next to the "wake-up" label).
export function timerMessage(prompt: string | null): string | null {
  return prompt === null ? null : prompt.replace(PROMPT_HEADER, '');
}

// A session that is closed or being closed takes no timer: `stored` is false then and nothing changes.
export function setTimer(
  db: Database,
  sessionId: number,
  timer: PendingTimer,
): { stored: boolean; replaced: PendingTimer | null } {
  return db
    .transaction((): { stored: boolean; replaced: PendingTimer | null } => {
      const row = db
        .prepare('SELECT * FROM chat_sessions WHERE id = ? AND closed_at IS NULL AND close_requested_at IS NULL')
        .get(sessionId);
      if (row === undefined) return { stored: false, replaced: null };
      const replaced = toChatSession(row).timer;
      db.prepare(
        'UPDATE chat_sessions SET timer_fire_at = ?, timer_message = ?, timer_created_at = ? WHERE id = ?',
      ).run(timer.fireAt, timer.message, timer.createdAt, sessionId);
      return { stored: true, replaced };
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

// Earliest instant >= fireAt inside the working hours, or null when the hours define no window (it would never fire).
export function nextFiringTime(fireAt: number, workingHours: WorkingHours): number | null {
  if (isWithinWorkingHours(fireAt, workingHours)) return fireAt;
  try {
    return nextWindowStart(fireAt, workingHours);
  } catch {
    return null;
  }
}

const isTransient = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string' &&
  /^SQLITE_(BUSY|LOCKED)/.test(error.code);

// Enqueues one `timer` Run per due, open Chat whose tip is finished and that has no queued or running turn and no
// close request, and clears the timer in the same IMMEDIATE transaction (so concurrent ticks cannot enqueue twice).
// A pending question does not block a timer. Each Chat is isolated in its own savepoint: a Chat that cannot fire for a
// permanent reason (unknown Repository, provider gated off, ...) loses its timer and is logged, and never blocks the
// others or repeats the failure every tick. A busy database is transient: it is rethrown and retried on the next tick.
// Returns the ids of the Runs enqueued.
export function fireDueChatTimers(deps: {
  db: Database;
  clock: Clock;
  queue: QueueService;
  configFor: ConfigFor;
  interactiveSupport?: (provider: ProviderName) => { supported: boolean; reason: string | null };
}): number[] {
  const { db, clock, queue } = deps;
  const support = deps.interactiveSupport ?? interactiveSupport;
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

  const fireOne = (id: number, now: number): number | null => {
    const session = toChatSession(db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id));
    const timer = session.timer;
    if (timer === null) return null;
    if (!isWithinWorkingHours(now, deps.configFor(session.repository).schedule.workingHours)) return null;
    const unsupported = support(session.provider);
    if (!unsupported.supported) {
      throw new Error(unsupported.reason ?? `Interactive mode is not available for provider "${session.provider}"`);
    }
    const busy = db.prepare("SELECT 1 FROM runs WHERE chat_session_id = ? AND status IN ('queued', 'running')").get(id);
    if (busy !== undefined) return null;
    const tip = db
      .prepare(
        `SELECT id, status FROM runs r WHERE r.chat_session_id = ?
           AND NOT EXISTS (SELECT 1 FROM runs c WHERE c.parent_run_id = r.id)
         ORDER BY r.id DESC LIMIT 1`,
      )
      .get(id) as { id: number; status: string } | undefined;
    if (tip === undefined || tip.status !== 'finished') return null;
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
    return run.id;
  };

  return db
    .transaction((): number[] => {
      const now = clock.now();
      const enqueued: number[] = [];
      for (const { id } of due(now)) {
        try {
          // A nested transaction is a savepoint: a throw rolls back only this Chat's changes.
          const runId = db.transaction(() => fireOne(id, now))();
          if (runId !== null) enqueued.push(runId);
        } catch (error) {
          if (isTransient(error)) throw error;
          cancelTimer(db, id);
          console.error(
            `${new Date().toISOString()} timers: Chat session #${id} cannot fire its wake-up and it was cancelled: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return enqueued;
    })
    .immediate();
}
