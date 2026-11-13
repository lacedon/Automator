import fs from 'node:fs';
import path from 'node:path';
import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import { providerOptions } from '../config/providers';
import type { Database } from '../db/open';
import { toRun } from '../db/rows';
import { err, ok, type Result } from '../domain/result';
import { parseTarget, tryParseUrl } from '../domain/targets';
import type { Clock, ProviderName, Run, RunStatus, WatchState, WorkflowType } from '../domain/types';
import { repositoryError } from '../files/attempts';
import type { DataDir } from '../files/dataDir';
import type { RepositoryService } from '../repositories/repositoryService';

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
  provider?: ProviderName;
  parentRunId?: number;
  branchedFromRunId?: number;
  branchContext?: string;
  sessionId?: string;
  ticketKey?: string;
  ticketTitle?: string | null;
  agentId?: number | null;
}

export interface AdhocRequest {
  repository: string;
  agentId?: number;
  prompt?: string;
  model?: string;
  ticket?: string;
}

export interface QueueDeps {
  configFor?: ConfigFor;
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
    private readonly repositories: RepositoryService,
    private readonly deps: QueueDeps = {},
  ) {}

  private configFor(repository: string): Config {
    return this.deps.configFor?.(repository) ?? this.config;
  }

  enqueueWatch(input: EnqueueWatchInput): Run {
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare("SELECT extra_instructions FROM runs WHERE watch_id = ? AND status = 'queued'")
          .get(input.watchId) as { extra_instructions: string | null } | undefined;
        const row = this.db
          .prepare(
            `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, extra_instructions, review_unresolved, provider, model, queued_at, workflow_type)
           VALUES (@watchId, @repository, 'queued', @trigger, @priority, @reason, @extra, @reviewUnresolved, @provider, @model, @now,
             (SELECT CASE kind WHEN 'mr' THEN 'mr-watch' WHEN 'jira' THEN 'jira-watch' ELSE 'free-watch' END FROM watches WHERE id = @watchId))
           ON CONFLICT (watch_id) WHERE status = 'queued' DO UPDATE SET
             priority = min(priority, excluded.priority),
             trigger = CASE WHEN excluded.trigger = 'manual' THEN 'manual' ELSE trigger END,
             reason = reason || '; ' || excluded.reason,
             extra_instructions = excluded.extra_instructions,
             review_unresolved = max(review_unresolved, excluded.review_unresolved)
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
            provider: this.configFor(input.repository).provider,
            model: input.model,
            now: this.clock.now(),
          });
        return toRun(row);
      })
      .immediate();
  }

  enqueueAdhoc(input: EnqueueAdhocInput): Run {
    const inherited =
      input.parentRunId === undefined
        ? undefined
        : (
            this.db.prepare('SELECT workflow_type FROM runs WHERE id = ?').get(input.parentRunId) as
              { workflow_type: WorkflowType } | undefined
          )?.workflow_type;
    const workflowType = inherited ?? (input.ticketKey === undefined ? 'free-adhoc' : 'ticket-adhoc');
    const row = this.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, ticket_key, ticket_title, provider, model, parent_run_id, session_id, queued_at, workflow_type, agent_id, branched_from_run_id, branch_context)
           VALUES (NULL, ?, 'queued', 'adhoc', 0, 'ad-hoc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.repository,
        input.prompt,
        input.ticketKey ?? null,
        input.ticketTitle ?? null,
        input.provider ?? this.configFor(input.repository).provider,
        input.model,
        input.parentRunId ?? null,
        input.sessionId ?? null,
        this.clock.now(),
        workflowType,
        input.agentId ?? null,
        input.branchedFromRunId ?? null,
        input.branchContext ?? null,
      );
    return toRun(row);
  }

  requestFollowUp(runId: number, message: string): Result<{ run: Run }> {
    return this.db
      .transaction((): Result<{ run: Run }> => {
        const parent = this.db
          .prepare('SELECT watch_id, status, repository, provider, model, session_id, agent_id FROM runs WHERE id = ?')
          .get(runId) as
          | {
              watch_id: number | null;
              status: RunStatus;
              repository: string;
              provider: ProviderName;
              model: string;
              session_id: string | null;
              agent_id: number | null;
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
            message: 'This Run has no provider session to continue',
          });
        const invalidRepository = repositoryError(this.repositories, this.dataDir, parent.repository, this.clock.now());
        if (invalidRepository) return err(invalidRepository);
        return ok({
          run: this.enqueueAdhoc({
            repository: parent.repository,
            prompt,
            provider: parent.provider,
            model: parent.model,
            parentRunId: runId,
            sessionId: parent.session_id,
            agentId: parent.agent_id,
          }),
        });
      })
      .immediate();
  }

  // Starts a new Chat whose first Run is told the conversation up to and including `runId`; the original is untouched.
  requestBranch(runId: number, message: string): Result<{ run: Run }> {
    return this.db
      .transaction((): Result<{ run: Run }> => {
        const target = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (target === undefined) return err({ code: 'NOT_FOUND' });
        const run = toRun(target);
        if (run.watchId !== null)
          return err({ code: 'INVALID_INPUT', field: 'run', message: 'Branching is only available for ad-hoc Runs' });
        const prompt = message.trim();
        if (prompt === '') return err({ code: 'INVALID_INPUT', field: 'message', message: 'Message is required' });
        if (prompt.length > MAX_FOLLOW_UP_CHARS)
          return err({
            code: 'INVALID_INPUT',
            field: 'message',
            message: `Message is too long (max ${MAX_FOLLOW_UP_CHARS} characters)`,
          });
        if (run.status !== 'finished') return err({ code: 'INVALID_STATE', state: run.status, action: 'branch' });
        const invalidRepository = repositoryError(this.repositories, this.dataDir, run.repository, this.clock.now());
        if (invalidRepository) return err(invalidRepository);
        // Walk up to the Chat's first Run, then render each exchange down to the selected one.
        const parentOf = this.db.prepare('SELECT * FROM runs WHERE id = ?');
        const chain = [run];
        const seen = new Set([run.id]);
        for (let cur = run; cur.parentRunId !== null && !seen.has(cur.parentRunId);) {
          const parent = parentOf.get(cur.parentRunId);
          if (parent === undefined) break;
          cur = toRun(parent);
          seen.add(cur.id);
          chain.unshift(cur);
        }
        // A branched chat's first Run carries the earlier conversation; keep it and continue its numbering.
        const earlier = chain[0].branchContext;
        const offset = earlier === null ? 0 : (earlier.match(/^### Exchange \d+$/gm)?.length ?? 0);
        const context = [
          ...(earlier === null ? [] : [earlier]),
          ...chain.map((r, i) => {
            const request = r.adhocPrompt?.trim() || r.ticketKey || '(none)';
            const response = r.error !== null ? `Error: ${r.error.message}` : (r.summary ?? '(no summary)');
            return `### Exchange ${offset + i + 1}\n\nUser: ${request}\n\nAgent: ${response}`;
          }),
        ].join('\n\n');
        return ok({
          run: this.enqueueAdhoc({
            repository: run.repository,
            prompt,
            provider: run.provider,
            model: run.model,
            agentId: run.agentId,
            branchedFromRunId: run.id,
            branchContext: context,
          }),
        });
      })
      .immediate();
  }

  async requestAdhoc(input: AdhocRequest): Promise<Result<{ run: Run; warning?: string }>> {
    const invalidRepository = repositoryError(this.repositories, this.dataDir, input.repository, this.clock.now());
    if (invalidRepository) return err(invalidRepository);
    const config = this.configFor(input.repository);
    const options = providerOptions(config, config.provider);
    const model = input.model ?? options.defaultModel;
    if (![options.defaultModel, ...options.models].includes(model)) {
      return err({
        code: 'INVALID_INPUT',
        field: 'model',
        message: `Model "${model}" is not configured for ${config.provider}`,
      });
    }
    if (input.agentId !== undefined && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(input.agentId)) {
      return err({ code: 'INVALID_INPUT', field: 'agentId', message: `Agent #${input.agentId} does not exist` });
    }
    let ticket: { key: string; title: string | null } | undefined;
    let warning: string | undefined;
    const prompt = input.prompt?.trim() || null;
    if (input.ticket !== undefined) {
      const ticketValue = input.ticket.trim();
      if (tryParseUrl(ticketValue) !== null) {
        ticket = { key: ticketValue, title: null };
      } else {
        if (!config.jira.enabled) return err({ code: 'JIRA_DISABLED' });
        const target = parseTarget(ticketValue, this.config, this.repositories.get(input.repository));
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
      }
    } else if (prompt === null) {
      return err({ code: 'INVALID_INPUT', field: 'prompt', message: 'Prompt is required' });
    }
    const queued = this.db
      .transaction((): Result<Run> => {
        const invalidRepository = repositoryError(this.repositories, this.dataDir, input.repository, this.clock.now());
        if (invalidRepository) return err(invalidRepository);
        const repository = this.repositories.get(input.repository);
        if (repository === null) return err({ code: 'NOT_FOUND' });
        return ok(
          this.enqueueAdhoc({
            repository: repository.name,
            prompt,
            provider: config.provider,
            model,
            agentId: input.agentId,
            ticketKey: ticket?.key,
            ticketTitle: ticket?.title,
          }),
        );
      })
      .immediate();
    if (!queued.ok) return queued;
    const run = queued.value;
    return ok(warning === undefined ? { run } : { run, warning });
  }

  // Checkout identity: Repository records pointing at the same folder share it; unknown Repositories stand alone.
  private checkoutKey(repository: string): string {
    const folder = this.repositories.get(repository)?.folder;
    if (folder === undefined) return `repository:${repository.toLowerCase()}`;
    try {
      return fs.realpathSync(folder);
    } catch {
      return path.resolve(folder);
    }
  }

  // Claims the oldest queued Run that may start now. A Run whose checkout is busy is skipped, never blocking others.
  claimNext(): Run | null {
    return this.db
      .transaction((): Run | null => {
        const running = (
          this.db.prepare("SELECT repository, isolation FROM runs WHERE status = 'running'").all() as {
            repository: string;
            isolation: 'shared' | 'copy';
          }[]
        ).map((r) => ({ key: this.checkoutKey(r.repository), isolation: r.isolation }));
        const queued = this.db
          .prepare(
            `SELECT r.id, r.repository, r.trigger, w.state AS watch_state FROM runs r
         LEFT JOIN watches w ON w.id = r.watch_id
         WHERE r.status = 'queued'
         ORDER BY r.priority, r.queued_at, r.id`,
          )
          .all() as { id: number; repository: string; trigger: string; watch_state: WatchState | null }[];
        for (const row of queued) {
          const state = row.watch_state;
          if (state === 'closed' || state === 'needs_you' || (state === 'paused' && row.trigger === 'schedule')) {
            this.db.prepare('DELETE FROM runs WHERE id = ?').run(row.id);
            continue;
          }
          const { isolation, maxConcurrent } = this.configFor(row.repository).runs;
          const key = this.checkoutKey(row.repository);
          const sameCheckout = running.filter((r) => r.key === key);
          const blocked =
            isolation === 'shared'
              ? sameCheckout.length > 0
              : sameCheckout.some((r) => r.isolation === 'shared') || sameCheckout.length >= maxConcurrent;
          if (blocked) continue;
          return toRun(
            this.db
              .prepare("UPDATE runs SET status = 'running', started_at = ?, isolation = ? WHERE id = ? RETURNING *")
              .get(this.clock.now(), isolation, row.id),
          );
        }
        return null;
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

  // Marks a finished Run that needs the user (Needs you or Error) as Done. Irreversible.
  closeRun(runId: number): Result<void> {
    return this.db
      .transaction((): Result<void> => {
        const row = this.db
          .prepare('SELECT status, outcome, result_status, interrupted, closed_at FROM runs WHERE id = ?')
          .get(runId) as
          | {
              status: RunStatus;
              outcome: string | null;
              result_status: string | null;
              interrupted: string | null;
              closed_at: number | null;
            }
          | undefined;
        if (!row) return err({ code: 'NOT_FOUND' });
        const needsUser = row.interrupted === null && (row.result_status === 'error' || row.outcome === 'needs-you');
        if (row.status !== 'finished' || row.closed_at !== null || !needsUser) {
          return err({ code: 'INVALID_STATE', state: row.status, action: 'closeRun' });
        }
        this.db.prepare('UPDATE runs SET closed_at = ? WHERE id = ?').run(this.clock.now(), runId);
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
