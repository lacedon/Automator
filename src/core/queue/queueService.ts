import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toRun } from '../db/rows';
import { err, ok, type Result } from '../domain/result';
import type { Clock, Run, RunStatus, WatchState } from '../domain/types';
import { unknownRepositoryError } from '../files/attempts';
import type { DataDir } from '../files/dataDir';

export interface EnqueueWatchInput {
  watchId: number;
  repository: string;
  trigger: 'schedule' | 'manual';
  reason: string;
  model: string;
  extraInstructions?: string;
  reviewUnresolved?: boolean;
}

export interface EnqueueAdhocInput {
  repository: string;
  prompt: string;
  model: string;
}

function paragraphs(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function mergeInstructions(existing: string | null, added: string | undefined): string | null {
  const result = paragraphs(existing);
  for (const p of paragraphs(added)) if (!result.includes(p)) result.push(p);
  return result.length > 0 ? result.join('\n\n') : null;
}

export class QueueService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly dataDir: DataDir,
    private readonly config: Config,
  ) {}

  enqueueWatch(input: EnqueueWatchInput): Run {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT extra_instructions FROM runs WHERE watch_id = ? AND status = 'queued'")
        .get(input.watchId) as { extra_instructions: string | null } | undefined;
      const row = this.db
        .prepare(
          `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, extra_instructions, review_unresolved, model, queued_at)
           VALUES (@watchId, @repository, 'queued', @trigger, @priority, @reason, @extra, @reviewUnresolved, @model, @now)
           ON CONFLICT (watch_id) WHERE status = 'queued' DO UPDATE SET
             priority = min(priority, excluded.priority),
             trigger = CASE WHEN excluded.trigger = 'manual' THEN 'manual' ELSE trigger END,
             reason = reason || '; ' || excluded.reason,
             extra_instructions = excluded.extra_instructions,
             review_unresolved = max(review_unresolved, excluded.review_unresolved),
             model = excluded.model
           RETURNING *`,
        )
        .get({
          watchId: input.watchId,
          repository: input.repository,
          trigger: input.trigger,
          priority: input.trigger === 'schedule' ? 1 : 0,
          reason: input.reason,
          extra: mergeInstructions(existing?.extra_instructions ?? null, input.extraInstructions),
          reviewUnresolved: input.reviewUnresolved ? 1 : 0,
          model: input.model,
          now: this.clock.now(),
        });
      return toRun(row);
    }).immediate();
  }

  enqueueAdhoc(input: EnqueueAdhocInput): Run {
    const row = this.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, model, queued_at)
         VALUES (NULL, ?, 'queued', 'adhoc', 0, 'ad-hoc', ?, ?, ?)
         RETURNING *`,
      )
      .get(input.repository, input.prompt, input.model, this.clock.now());
    return toRun(row);
  }

  enqueueAdhocChecked(input: { repository: string; prompt: string; model?: string }): Result<Run> {
    const unknown = unknownRepositoryError(this.config, this.dataDir, input.repository, this.clock.now());
    if (unknown) return err(unknown);
    return ok(this.enqueueAdhoc({ ...input, model: input.model ?? this.config.runs.defaultModel }));
  }

  claimNext(): Run | null {
    return this.db.transaction((): Run | null => {
      if (this.db.prepare("SELECT 1 FROM runs WHERE status = 'running'").get()) return null;
      const next = this.db.prepare(
        `SELECT r.id, r.trigger, w.state AS watch_state FROM runs r
         LEFT JOIN watches w ON w.id = r.watch_id
         WHERE r.status = 'queued'
         ORDER BY r.priority, r.queued_at, r.id
         LIMIT 1`,
      );
      for (;;) {
        const row = next.get() as { id: number; trigger: string; watch_state: WatchState | null } | undefined;
        if (!row) return null;
        const state = row.watch_state;
        if (state === 'closed' || state === 'needs_you' || (state === 'paused' && row.trigger === 'schedule')) {
          this.db.prepare('DELETE FROM runs WHERE id = ?').run(row.id);
          continue;
        }
        return toRun(
          this.db
            .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? RETURNING *")
            .get(this.clock.now(), row.id),
        );
      }
    }).immediate();
  }

  cancel(runId: number): Result<'deleted' | 'cancel-requested'> {
    return this.db.transaction((): Result<'deleted' | 'cancel-requested'> => {
      const status = this.status(runId);
      if (!status) return err({ code: 'NOT_FOUND' });
      if (status === 'queued') {
        this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
        return ok('deleted');
      }
      if (status === 'running') {
        this.db
          .prepare('UPDATE runs SET cancel_requested_at = coalesce(cancel_requested_at, ?) WHERE id = ?')
          .run(this.clock.now(), runId);
        return ok('cancel-requested');
      }
      return err({ code: 'INVALID_STATE', state: status, action: 'cancel' });
    }).immediate();
  }

  deleteAdhoc(runId: number): Result<void> {
    const result = this.db.transaction((): Result<void> => {
      const row = this.db.prepare('SELECT watch_id, status FROM runs WHERE id = ?').get(runId) as
        | { watch_id: number | null; status: RunStatus }
        | undefined;
      if (!row) return err({ code: 'NOT_FOUND' });
      if (row.watch_id !== null || row.status !== 'finished') {
        return err({ code: 'INVALID_STATE', state: row.status, action: 'deleteAdhoc' });
      }
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
      return ok(undefined);
    }).immediate();
    if (result.ok) this.dataDir.removeRunDir(runId);
    return result;
  }

  removeQueuedForWatch(watchId: number): void {
    this.db.prepare("DELETE FROM runs WHERE watch_id = ? AND status = 'queued'").run(watchId);
  }

  position(runId: number): number | null {
    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM runs q
                 WHERE q.status = 'queued' AND (q.priority, q.queued_at, q.id) <= (r.priority, r.queued_at, r.id)) AS pos
         FROM runs r WHERE r.id = ? AND r.status = 'queued'`,
      )
      .get(runId) as { pos: number } | undefined;
    return row ? row.pos : null;
  }

  private status(runId: number): RunStatus | null {
    const row = this.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: RunStatus } | undefined;
    return row ? row.status : null;
  }
}
