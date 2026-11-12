import path from 'node:path';
import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import { providerOptions } from '../config/providers';
import type { Database } from '../db/open';
import { toWatch } from '../db/rows';
import { intervalFor, isWithinWorkingHours } from '../domain/schedule';
import type { Clock, NeedsYouEvent, Watch } from '../domain/types';
import { writeAttemptError } from '../files/attempts';
import type { DataDir } from '../files/dataDir';
import { precheckFor, type Prechecks } from '../prechecks/index';
import { SCRIPT_TIMEOUT_MS } from '../prechecks/script';
import type { PrecheckResult } from '../prechecks/types';
import type { QueueService } from '../queue/queueService';
import { closeWatch, enterNeedsYou } from '../watches/needsYou';
import type { RepositoryService } from '../repositories/repositoryService';

const MAX_CHECK_FAILURES = 3;
const CHECK_CONCURRENCY = 5;
const CHECK_TIMEOUT_MS = 90_000;
// A pre-check script has its own 15 min limit; this only guards against a hung runner.
const SCRIPT_CHECK_TIMEOUT_MS = SCRIPT_TIMEOUT_MS + 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export interface SchedulerDeps {
  db: Database;
  clock: Clock;
  config: Config;
  configFor?: ConfigFor;
  dataDir: DataDir;
  queue: QueueService;
  repositories: Pick<RepositoryService, 'status'>;
  prechecks: Prechecks;
  onNeedsYou(e: NeedsYouEvent): void | Promise<void>;
}

export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  private configFor(repository: string): Config {
    return this.deps.configFor?.(repository) ?? this.deps.config;
  }

  // Checks run concurrently with a deadline each, so one slow or hung pre-check cannot hold back the others.
  async tick(): Promise<{ checked: number; enqueued: number }> {
    const { clock } = this.deps;
    const totals = { checked: 0, enqueued: 0 };
    const queue = this.dueWatches(clock.now());
    const worker = async () => {
      for (let watch = queue.shift(); watch !== undefined; watch = queue.shift()) {
        await this.process(watch, totals);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, worker));
    return totals;
  }

  private async process(watch: Watch, totals: { checked: number; enqueued: number }): Promise<void> {
    const { clock } = this.deps;
    const config = this.configFor(watch.repository);
    if (!isWithinWorkingHours(clock.now(), config.schedule.workingHours)) return;
    if (watch.kind === 'jira' && !config.jira.enabled) return;
    try {
      const timeoutMs = watch.precheckScript === null ? CHECK_TIMEOUT_MS : SCRIPT_CHECK_TIMEOUT_MS;
      const result = await withTimeout(this.check(watch), timeoutMs, `Pre-check timed out after ${timeoutMs / 1000}s`);
      const enqueued = this.apply(watch.id, result);
      totals.checked += 1;
      if (enqueued) totals.enqueued += 1;
    } catch (e) {
      console.error(
        `${new Date().toISOString()} scheduler: Automation #${watch.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.postpone(watch);
    }
  }

  // A failing Automation still moves on by its interval so it cannot block the others.
  private postpone(watch: Watch): void {
    const { db, clock } = this.deps;
    try {
      const now = clock.now();
      db.prepare("UPDATE watches SET next_check_at = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(
        now + intervalFor(watch, this.configFor(watch.repository)),
        now,
        watch.id,
      );
    } catch (e) {
      console.error(
        `${new Date().toISOString()} scheduler: cannot postpone Automation #${watch.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private dueWatches(now: number): Watch[] {
    return this.deps.db
      .prepare(
        `SELECT * FROM watches w
         WHERE w.state = 'active' AND w.next_check_at <= ?
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.watch_id = w.id AND r.status IN ('queued', 'running'))
         ORDER BY w.next_check_at, w.id`,
      )
      .all(now)
      .map(toWatch);
  }

  private check(watch: Watch): Promise<PrecheckResult> {
    const { clock, dataDir, prechecks, repositories } = this.deps;
    const issues = repositories.status(watch.repository);
    if (issues.length > 0) {
      const message = `Repository "${watch.repository}" is invalid: ${issues.join('; ')}`;
      const attempt = writeAttemptError(
        dataDir,
        { code: 'REPOSITORY_UNAVAILABLE', repository: watch.repository, message, issues },
        clock.now(),
      );
      const resultReference =
        attempt.path === null
          ? `\n\nError result could not be written: ${attempt.writeError ?? 'unknown write error'}`
          : `\n\nError result: /files/attempt/${path.basename(attempt.path)}`;
      return Promise.resolve({
        kind: 'blocked',
        message: `${message}${resultReference}`,
      });
    }
    if (watch.kind === 'jira' && !prechecks.jira.hasToken(watch)) {
      return Promise.resolve({ kind: 'changed', reason: 'interval' });
    }
    return precheckFor(prechecks, watch.kind).check(watch);
  }

  // Applies one check outcome atomically; returns whether a Run was enqueued.
  private apply(watchId: number, result: PrecheckResult): boolean {
    const { db, clock, queue } = this.deps;
    let event: NeedsYouEvent | null = null;
    const enqueued = db
      .transaction((): boolean => {
        const row = db.prepare("SELECT * FROM watches WHERE id = ? AND state = 'active'").get(watchId);
        if (!row) return false;
        const watch = toWatch(row);
        const config = this.configFor(watch.repository);
        const modelOptions = providerOptions(config, config.provider);
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
              model: watch.model ?? modelOptions.defaultModel,
            });
            break;
          case 'unchanged':
            cursor = result.cursor ?? cursor;
            break;
          case 'close':
            closeWatch(db, watchId, result.reason, now);
            return false;
          case 'blocked':
            needsYou(result.message);
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
        ).run(
          failures,
          cursor === null ? null : JSON.stringify(cursor),
          now + intervalFor(watch, config),
          now,
          watchId,
        );
        if ((result.kind === 'changed' || result.kind === 'unchanged') && result.script !== undefined) {
          // A failed script keeps the last good output so a later success is still compared against it.
          db.prepare(
            'UPDATE watches SET precheck_output = coalesce(?, precheck_output), precheck_problem = ? WHERE id = ?',
          ).run(result.script.output, result.script.problem, watchId);
        }
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
