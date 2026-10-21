import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toWatch } from '../db/rows';
import { intervalFor, isWithinWorkingHours } from '../domain/schedule';
import type { Clock, NeedsYouEvent, Watch } from '../domain/types';
import { precheckFor, type Prechecks } from '../prechecks/index';
import type { PrecheckResult } from '../prechecks/types';
import type { QueueService } from '../queue/queueService';
import { closeWatch, enterNeedsYou } from '../watches/needsYou';

const MAX_CHECK_FAILURES = 3;

export interface SchedulerDeps {
  db: Database;
  clock: Clock;
  config: Config;
  queue: QueueService;
  prechecks: Prechecks;
  onNeedsYou(e: NeedsYouEvent): void | Promise<void>;
}

export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  async tick(): Promise<{ checked: number; enqueued: number }> {
    const { clock, config } = this.deps;
    const totals = { checked: 0, enqueued: 0 };
    if (!isWithinWorkingHours(clock.now(), config.schedule.workingHours)) return totals;
    for (const watch of this.dueWatches(clock.now())) {
      const result = await this.check(watch);
      totals.checked += 1;
      if (this.apply(watch.id, result)) totals.enqueued += 1;
    }
    return totals;
  }

  private dueWatches(now: number): Watch[] {
    return this.deps.db
      .prepare(
        `SELECT * FROM watches w
         WHERE w.state = 'active' AND w.next_check_at <= ?
           AND (w.kind <> 'jira' OR ?)
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.watch_id = w.id AND r.status IN ('queued', 'running'))
         ORDER BY w.next_check_at, w.id`,
      )
      .all(now, this.deps.config.jira.enabled ? 1 : 0)
      .map(toWatch);
  }

  private check(watch: Watch): Promise<PrecheckResult> {
    const { prechecks } = this.deps;
    if (watch.kind === 'jira' && !prechecks.jira.hasToken(watch)) {
      return Promise.resolve({ kind: 'changed', reason: 'interval' });
    }
    return precheckFor(prechecks, watch.kind).check(watch);
  }

  // Applies one check outcome atomically; returns whether a Run was enqueued.
  private apply(watchId: number, result: PrecheckResult): boolean {
    const { db, clock, config, queue } = this.deps;
    let event: NeedsYouEvent | null = null;
    const enqueued = db
      .transaction((): boolean => {
        const row = db.prepare("SELECT * FROM watches WHERE id = ? AND state = 'active'").get(watchId);
        if (!row) return false;
        const watch = toWatch(row);
        const now = clock.now();
        const needsYou = (reason: string) => {
          event = enterNeedsYou(db, { watchId, runId: null, reason, now, teamsEnabled: config.teams !== undefined });
        };
        let failures = 0;
        let cursor = watch.cursor;
        switch (result.kind) {
          case 'changed':
            queue.enqueueWatch({
              watchId,
              repository: watch.repository,
              trigger: 'schedule',
              reason: result.reason,
              model: watch.model ?? config.runs.defaultModel,
            });
            break;
          case 'unchanged':
            cursor = result.cursor ?? cursor;
            break;
          case 'close':
            closeWatch(db, watchId, result.reason, now);
            return false;
          case 'failed':
            failures = watch.checkFailures + 1;
            if (result.auth) {
              needsYou(result.message);
              return false;
            }
            if (failures >= MAX_CHECK_FAILURES) {
              needsYou(`Pre-check failed ${MAX_CHECK_FAILURES} times: ${result.message}`);
              return false;
            }
            break;
        }
        db.prepare(
          `UPDATE watches SET check_failures = ?, cursor_json = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
        ).run(failures, cursor === null ? null : JSON.stringify(cursor), now + intervalFor(watch, config), now, watchId);
        return result.kind === 'changed';
      })
      .immediate();
    if (event) this.notify(event);
    return enqueued;
  }

  private notify(event: NeedsYouEvent): void {
    try {
      void Promise.resolve(this.deps.onNeedsYou(event)).catch(() => {});
    } catch {
      // Notification is best-effort.
    }
  }
}
