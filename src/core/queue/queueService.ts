import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toRun } from '../db/rows';
import { err, ok, type Result } from '../domain/result';
import { parseTarget } from '../domain/targets';
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

export const MAX_FOLLOW_UP_CHARS = 20_000;

export interface EnqueueAdhocInput {
  repository: string;
  prompt: string | null;
  model: string;
  parentRunId?: number;
  ticketKey?: string;
  ticketTitle?: string | null;
}

export interface AdhocRequest {
  repository: string;
  prompt?: string;
  model?: string;
  ticket?: string;
}

export interface QueueDeps {
  ticketTitle?: (connection: string, key: string) => Promise<string>;
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
    private readonly deps: QueueDeps = {},
  ) {}

  enqueueWatch(input: EnqueueWatchInput): Run {
    return this.db
      .transaction(() => {
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
      })
      .immediate();
  }

  enqueueAdhoc(input: EnqueueAdhocInput): Run {
    const row = this.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, ticket_key, ticket_title, model, parent_run_id, queued_at)
         VALUES (NULL, ?, 'queued', 'adhoc', 0, 'ad-hoc', ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.repository,
        input.prompt,
        input.ticketKey ?? null,
        input.ticketTitle ?? null,
        input.model,
        input.parentRunId ?? null,
        this.clock.now(),
      );
    return toRun(row);
  }

  requestFollowUp(runId: number, message: string): Result<{ run: Run }> {
    return this.db
      .transaction((): Result<{ run: Run }> => {
        const parent = this.db
          .prepare('SELECT watch_id, status, repository, model, session_id FROM runs WHERE id = ?')
          .get(runId) as
          | {
              watch_id: number | null;
              status: RunStatus;
              repository: string;
              model: string;
              session_id: string | null;
            }
          | undefined;
        if (!parent) return err({ code: 'NOT_FOUND' });
        if (parent.watch_id !== null)
          return err({ code: 'INVALID_INPUT', field: 'run', message: 'Chat is only available for ad-hoc Runs' });
        const prompt = message.trim();
        if (prompt === '') return err({ code: 'INVALID_INPUT', field: 'message', message: 'Message is required' });
        if (prompt.length > MAX_FOLLOW_UP_CHARS)
          return err({
            code: 'INVALID_INPUT',
            field: 'message',
            message: `Message is too long (max ${MAX_FOLLOW_UP_CHARS} characters)`,
          });
        if (parent.status !== 'finished')
          return err({ code: 'INVALID_STATE', state: parent.status, action: 'followUp' });
        if (this.db.prepare('SELECT 1 FROM runs WHERE parent_run_id = ?').get(runId))
          return err({ code: 'INVALID_INPUT', field: 'run', message: 'Reply on the latest Run in the thread' });
        if (parent.session_id === null)
          return err({
            code: 'INVALID_INPUT',
            field: 'run',
            message: 'This Run has no Copilot session to continue',
          });
        const unknown = unknownRepositoryError(this.config, this.dataDir, parent.repository, this.clock.now());
        if (unknown) return err(unknown);
        return ok({
          run: this.enqueueAdhoc({
            repository: parent.repository,
            prompt,
            model: parent.model,
            parentRunId: runId,
          }),
        });
      })
      .immediate();
  }

  async requestAdhoc(input: AdhocRequest): Promise<Result<{ run: Run; warning?: string }>> {
    const unknown = unknownRepositoryError(this.config, this.dataDir, input.repository, this.clock.now());
    if (unknown) return err(unknown);
    let ticket: { key: string; title: string | null } | undefined;
    let warning: string | undefined;
    const prompt = input.prompt?.trim() || null;
    if (input.ticket !== undefined) {
      if (!this.config.jira.enabled) return err({ code: 'JIRA_DISABLED' });
      const target = parseTarget(input.ticket, this.config, input.repository);
      if (!target.ok)
        return err({
          code: 'INVALID_INPUT',
          field: 'ticket',
          message: target.error.code === 'INVALID_TARGET' ? target.error.message : 'Invalid Ticket',
        });
      if (target.value.jira === undefined)
        return err({ code: 'INVALID_INPUT', field: 'ticket', message: 'Not a Jira ticket' });
      const { conn, key } = target.value.jira;
      let title: string | null = null;
      try {
        title = (await this.deps.ticketTitle?.(conn, key)) ?? null;
      } catch (e) {
        warning = `Could not fetch the Ticket title: ${e instanceof Error && e.message ? e.message : 'unknown error'}`;
      }
      ticket = { key, title };
    } else if (prompt === null) {
      return err({ code: 'INVALID_INPUT', field: 'prompt', message: 'Prompt is required' });
    }
    const run = this.enqueueAdhoc({
      repository: input.repository,
      prompt,
      model: input.model ?? this.config.runs.defaultModel,
      ticketKey: ticket?.key,
      ticketTitle: ticket?.title,
    });
    return ok(warning === undefined ? { run } : { run, warning });
  }

  claimNext(): Run | null {
    return this.db
      .transaction((): Run | null => {
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
      })
      .immediate();
  }

  cancel(runId: number): Result<'deleted' | 'cancel-requested'> {
    return this.db
      .transaction((): Result<'deleted' | 'cancel-requested'> => {
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
      })
      .immediate();
  }

  // Unlike cancel, never flags a Run that started in the meantime: stopping a running Run needs its own confirmation.
  cancelQueued(runId: number): Result<void> {
    return this.db
      .transaction((): Result<void> => {
        const status = this.status(runId);
        if (!status) return err({ code: 'NOT_FOUND' });
        if (status !== 'queued') return err({ code: 'INVALID_STATE', state: status, action: 'cancelQueued' });
        this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
        return ok(undefined);
      })
      .immediate();
  }

  deleteAdhoc(runId: number): Result<void> {
    const result = this.db
      .transaction((): Result<void> => {
        const row = this.db.prepare('SELECT watch_id, status FROM runs WHERE id = ?').get(runId) as
          { watch_id: number | null; status: RunStatus } | undefined;
        if (!row) return err({ code: 'NOT_FOUND' });
        if (row.watch_id !== null || row.status !== 'finished') {
          return err({ code: 'INVALID_STATE', state: row.status, action: 'deleteAdhoc' });
        }
        this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
        return ok(undefined);
      })
      .immediate();
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
