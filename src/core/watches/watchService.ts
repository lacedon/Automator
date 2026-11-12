import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import { providerOptions } from '../config/providers';
import type { Database } from '../db/open';
import { toWatch } from '../db/rows';
import { err, ok, type AppError, type Result } from '../domain/result';
import { intervalFor } from '../domain/schedule';
import { parseTarget, type ParsedTarget } from '../domain/targets';
import type { Clock, InitialReview, Run, Watch, WatchKind, WatchState } from '../domain/types';
import { nextState, type WatchAction } from '../domain/watchState';
import { repositoryError } from '../files/attempts';
import type { DataDir } from '../files/dataDir';
import type { QueueService } from '../queue/queueService';
import { closeWatch } from './needsYou';
import type { RepositoryService } from '../repositories/repositoryService';

export type TargetPreview = { title: string; state: 'opened' | 'merged' | 'closed' | string; sourceBranch?: string };

export interface WatchServiceDeps {
  db: Database;
  clock: Clock;
  config: Config;
  configFor?: ConfigFor;
  repositories: RepositoryService;
  queue: QueueService;
  dataDir: DataDir;
  preview?: (t: ParsedTarget, repository: string) => Promise<TargetPreview | null>;
}

export interface CreateWatchInput {
  target: string;
  repository: string;
  instructions?: string;
  intervalMs?: number;
  model?: string;
  agentId?: number;
  initialReview?: InitialReview;
  title?: string;
  // The script is generated from the instructions beforehand (see PrecheckScriptService).
  precheckInstructions?: string;
  precheckScript?: string;
}

export interface UpdateWatchInput {
  instructions?: string | null;
  intervalMs?: number | null;
  model?: string | null;
  initialReview?: InitialReview | null;
  // Blank clears the pre-check; changed instructions need the script generated from them.
  precheckInstructions?: string | null;
  precheckScript?: string;
}

export type PreviewTargetResult = {
  kind: WatchKind | null;
  preview: TargetPreview | null;
  previewError?: string;
  error?: AppError;
};

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function invalidInterval(intervalMs: number | null | undefined): AppError | null {
  if (intervalMs === null || intervalMs === undefined || (Number.isInteger(intervalMs) && intervalMs > 0)) return null;
  return {
    code: 'INVALID_INPUT',
    field: 'intervalMs',
    message: `Interval must be a positive whole number of milliseconds, got ${intervalMs}`,
  };
}

function invalidModel(config: Config, model: string | null | undefined): AppError | null {
  const selected = blankToNull(model);
  if (selected === null) return null;
  const options = providerOptions(config, config.provider);
  if ([options.defaultModel, ...options.models].includes(selected)) return null;
  return {
    code: 'INVALID_INPUT',
    field: 'model',
    message: `Model "${selected}" is not configured for ${config.provider}`,
  };
}

function invalidPrecheck(kind: WatchKind, instructions: string | null, script: string | undefined): AppError | null {
  if (instructions === null) return null;
  const invalid = (message: string): AppError => ({ code: 'INVALID_INPUT', field: 'precheckInstructions', message });
  if (kind !== 'free') return invalid('Pre-check scripts are only available for free-form Automations');
  if (script === undefined) return invalid('The pre-check script has not been generated');
  return null;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export class WatchService {
  constructor(private readonly deps: WatchServiceDeps) {}

  private configFor(repository: string): Config {
    return this.deps.configFor?.(repository) ?? this.deps.config;
  }

  get(id: number): Watch | null {
    const row = this.deps.db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
    return row ? toWatch(row) : null;
  }

  list(filter: { state?: WatchState; repository?: string } = {}): Watch[] {
    return this.deps.db
      .prepare(
        `SELECT * FROM watches
         WHERE (@state IS NULL OR state = @state) AND (@repository IS NULL OR repository = @repository)
         ORDER BY id`,
      )
      .all({ state: filter.state ?? null, repository: filter.repository ?? null })
      .map(toWatch);
  }

  create(input: CreateWatchInput): Result<Watch> {
    const { config, clock, dataDir, repositories } = this.deps;
    const repository = repositories.get(input.repository);
    const invalidRepository = repositoryError(repositories, dataDir, input.repository, clock.now());
    if (invalidRepository) return err(invalidRepository);
    if (repository === null) return err({ code: 'NOT_FOUND' });

    const parsed = parseTarget(input.target, config, repository);
    if (!parsed.ok) return parsed;
    const target = parsed.value;
    const instructions = blankToNull(input.instructions);
    if (target.kind === 'free' && instructions === null) return err({ code: 'MISSING_INSTRUCTIONS' });
    const precheckInstructions = blankToNull(input.precheckInstructions);
    const badPrecheck = invalidPrecheck(target.kind, precheckInstructions, input.precheckScript);
    if (badPrecheck) return err(badPrecheck);
    const badInterval = invalidInterval(input.intervalMs);
    if (badInterval) return err(badInterval);
    const badModel = invalidModel(this.configFor(repository.name), input.model);
    if (badModel) return err(badModel);
    if (input.agentId !== undefined && !this.deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(input.agentId)) {
      return err({ code: 'INVALID_INPUT', field: 'agentId', message: `Agent #${input.agentId} does not exist` });
    }

    try {
      return this.deps.db
        .transaction((): Result<Watch> => {
          const duplicate = this.duplicateOf(target.normalizedTarget, repository.name);
          if (duplicate) return duplicate;
          const now = clock.now();
          const row = this.deps.db
            .prepare(
              `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, instructions,
                 interval_ms, model, initial_review, agent_id, precheck_instructions, precheck_script,
                 next_check_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING *`,
            )
            .get(
              target.kind,
              target.displayUrl,
              target.normalizedTarget,
              repository.name,
              blankToNull(input.title) ?? target.displayUrl,
              instructions,
              input.intervalMs ?? null,
              blankToNull(input.model),
              input.initialReview ?? null,
              input.agentId ?? null,
              precheckInstructions,
              precheckInstructions === null ? null : (input.precheckScript ?? null),
              now,
              now,
              now,
            );
          return ok(toWatch(row));
        })
        .immediate();
    } catch (e) {
      return this.backstop(e, target.normalizedTarget, repository.name);
    }
  }

  update(id: number, input: UpdateWatchInput): Result<Watch> {
    const badInterval = invalidInterval(input.intervalMs);
    if (badInterval) return err(badInterval);
    return this.deps.db
      .transaction((): Result<Watch> => {
        const watch = this.get(id);
        if (!watch) return err({ code: 'NOT_FOUND' });
        const badModel = invalidModel(this.configFor(watch.repository), input.model);
        if (badModel) return err(badModel);
        const sets: string[] = [];
        const params: Record<string, unknown> = { id, now: this.deps.clock.now() };
        if (input.instructions !== undefined) {
          const instructions = blankToNull(input.instructions);
          if (watch.kind === 'free' && instructions === null) return err({ code: 'MISSING_INSTRUCTIONS' });
          sets.push('instructions = @instructions');
          params.instructions = instructions;
        }
        if (input.intervalMs !== undefined) {
          sets.push('interval_ms = @intervalMs');
          params.intervalMs = input.intervalMs;
        }
        if (input.model !== undefined) {
          sets.push('model = @model');
          params.model = blankToNull(input.model);
        }
        if (input.initialReview !== undefined) {
          sets.push('initial_review = @initialReview');
          params.initialReview = input.initialReview;
        }
        if (input.precheckInstructions !== undefined) {
          const precheckInstructions = blankToNull(input.precheckInstructions);
          if (precheckInstructions !== watch.precheckInstructions) {
            const badPrecheck = invalidPrecheck(watch.kind, precheckInstructions, input.precheckScript);
            if (badPrecheck) return err(badPrecheck);
            // A new script starts without memory of the old one's output.
            sets.push(
              'precheck_instructions = @precheckInstructions',
              'precheck_script = @precheckScript',
              'precheck_output = NULL',
              'precheck_problem = NULL',
            );
            params.precheckInstructions = precheckInstructions;
            params.precheckScript = precheckInstructions === null ? null : (input.precheckScript ?? null);
          }
        }
        sets.push('updated_at = @now');
        return ok(
          toWatch(this.deps.db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = @id RETURNING *`).get(params)),
        );
      })
      .immediate();
  }

  pause(id: number): Result<Watch> {
    return this.act(id, 'pause', () => {
      this.deps.db
        .prepare("UPDATE watches SET state = 'paused', next_check_at = NULL, updated_at = ? WHERE id = ?")
        .run(this.deps.clock.now(), id);
      return ok(undefined);
    });
  }

  close(id: number): Result<Watch> {
    return this.act(id, 'close', () => {
      closeWatch(this.deps.db, id, 'user', this.deps.clock.now());
      return ok(undefined);
    });
  }

  reopen(id: number): Result<Watch> {
    try {
      return this.act(id, 'reopen', (watch) => {
        const duplicate = this.duplicateOf(watch.normalizedTarget, watch.repository);
        if (duplicate) return duplicate;
        const now = this.deps.clock.now();
        this.deps.db
          .prepare(
            `UPDATE watches SET state = 'active', closed_reason = NULL, closed_at = NULL, check_failures = 0,
               next_check_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(now, now, id);
        return ok(undefined);
      });
    } catch (e) {
      const watch = this.get(id);
      if (!watch) throw e;
      return this.backstop(e, watch.normalizedTarget, watch.repository);
    }
  }

  resume(id: number, opts: { note?: string; runNow?: boolean }): Result<Watch> {
    return this.act(id, opts.runNow ? 'resumeRunNow' : 'resume', (watch) => {
      if (opts.runNow && watch.kind === 'jira' && !this.configFor(watch.repository).jira.enabled)
        return err({ code: 'JIRA_DISABLED' });
      if (opts.runNow) {
        const invalidRepository = repositoryError(
          this.deps.repositories,
          this.deps.dataDir,
          watch.repository,
          this.deps.clock.now(),
        );
        if (invalidRepository) return err(invalidRepository);
      }
      const now = this.deps.clock.now();
      this.deps.db
        .prepare(
          `UPDATE watches SET state = 'active', needs_you_reason = NULL, needs_you_since = NULL, needs_you_run_id = NULL,
             check_failures = 0, resolution_note = coalesce(?, resolution_note), next_check_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(blankToNull(opts.note), now, now, id);
      if (opts.runNow) this.enqueueManual(watch, 'Resume & run now', {});
      return ok(undefined);
    });
  }

  runNow(id: number, opts: { extraInstructions?: string; reviewUnresolved?: boolean }): Result<Run> {
    return this.deps.db
      .transaction((): Result<Run> => {
        const watch = this.get(id);
        if (!watch) return err({ code: 'NOT_FOUND' });
        if (nextState(watch.state, 'runNow') === null) {
          return err({ code: 'INVALID_STATE', state: watch.state, action: 'runNow' });
        }
        if (watch.kind === 'jira' && !this.configFor(watch.repository).jira.enabled)
          return err({ code: 'JIRA_DISABLED' });
        const invalidRepository = repositoryError(
          this.deps.repositories,
          this.deps.dataDir,
          watch.repository,
          this.deps.clock.now(),
        );
        if (invalidRepository) return err(invalidRepository);
        return ok(this.enqueueManual(watch, 'Run now', opts));
      })
      .immediate();
  }

  delete(id: number): Result<void> {
    const { db } = this.deps;
    const result = db
      .transaction((): Result<{ runIds: number[]; eventIds: number[] }> => {
        const watch = this.get(id);
        if (!watch) return err({ code: 'NOT_FOUND' });
        const running = db.prepare("SELECT id FROM runs WHERE watch_id = ? AND status = 'running'").get(id) as
          { id: number } | undefined;
        if (running) return err({ code: 'RUN_IN_PROGRESS', runId: running.id });
        const ids = (sql: string) => (db.prepare(sql).all(id) as { id: number }[]).map((r) => r.id);
        const runIds = ids('SELECT id FROM runs WHERE watch_id = ?');
        const eventIds = ids('SELECT id FROM needs_you_events WHERE watch_id = ?');
        db.prepare('DELETE FROM watches WHERE id = ?').run(id);
        return ok({ runIds, eventIds });
      })
      .immediate();
    if (!result.ok) return result;
    for (const runId of result.value.runIds) this.deps.dataDir.removeRunDir(runId);
    for (const eventId of result.value.eventIds) this.deps.dataDir.removeNotifyFiles(eventId);
    return ok(undefined);
  }

  async previewTarget(target: string, repository: string): Promise<PreviewTargetResult> {
    const storedRepository = this.deps.repositories.get(repository);
    if (storedRepository === null) {
      return {
        kind: null,
        preview: null,
        error: {
          code: 'UNKNOWN_REPOSITORY',
          name: repository,
          known: this.deps.repositories
            .list()
            .map((entry) => entry.name)
            .sort(),
          attemptFile: null,
        },
      };
    }
    const issues = this.deps.repositories.status(storedRepository.name);
    if (issues.length > 0) {
      return {
        kind: null,
        preview: null,
        error: {
          code: 'INVALID_INPUT',
          field: 'repository',
          message: `Repository "${storedRepository.name}" is invalid: ${issues.join('; ')}`,
        },
      };
    }
    const parsed = parseTarget(target, this.deps.config, storedRepository);
    if (!parsed.ok) return { kind: null, preview: null, error: parsed.error };
    const { kind } = parsed.value;
    if (!this.deps.preview) return { kind, preview: null, previewError: 'Preview unavailable' };
    try {
      return { kind, preview: await this.deps.preview(parsed.value, repository) };
    } catch (e) {
      return { kind, preview: null, previewError: e instanceof Error && e.message ? e.message : 'Preview unavailable' };
    }
  }

  // Runs a state action in an immediate transaction: load, validate the transition, apply, return the updated Automation.
  private act(id: number, action: WatchAction, apply: (watch: Watch) => Result<void>): Result<Watch> {
    return this.deps.db
      .transaction((): Result<Watch> => {
        const watch = this.get(id);
        if (!watch) return err({ code: 'NOT_FOUND' });
        if (nextState(watch.state, action) === null) return err({ code: 'INVALID_STATE', state: watch.state, action });
        const applied = apply(watch);
        if (!applied.ok) return applied;
        return ok(this.get(id)!);
      })
      .immediate();
  }

  private enqueueManual(
    watch: Watch,
    reason: string,
    opts: { extraInstructions?: string; reviewUnresolved?: boolean },
  ): Run {
    const config = this.configFor(watch.repository);
    const options = providerOptions(config, config.provider);
    return this.deps.queue.enqueueWatch({
      watchId: watch.id,
      repository: watch.repository,
      trigger: 'manual',
      reason,
      model: watch.model ?? options.defaultModel,
      extraInstructions: opts.extraInstructions,
      reviewUnresolved: opts.reviewUnresolved,
    });
  }

  private duplicateOf(normalizedTarget: string, repository: string): { ok: false; error: AppError } | null {
    const row = this.deps.db
      .prepare("SELECT * FROM watches WHERE normalized_target = ? AND repository = ? AND state <> 'closed'")
      .get(normalizedTarget, repository);
    if (!row) return null;
    const existing = toWatch(row);
    return err({
      code: 'DUPLICATE_WATCH',
      existing: {
        id: existing.id,
        state: existing.state,
        intervalMs: intervalFor(existing, this.configFor(repository)),
      },
    });
  }

  // The partial unique index is the backstop when a concurrent writer wins the race after our pre-check.
  private backstop(e: unknown, normalizedTarget: string, repository: string): { ok: false; error: AppError } {
    const duplicate = isUniqueViolation(e) ? this.duplicateOf(normalizedTarget, repository) : null;
    if (!duplicate) throw e;
    return duplicate;
  }
}
