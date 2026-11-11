import type { ProjectScope, Trigger } from '../domain/types';
import { configOf, type ReadDeps } from './deps';
import { scopeFilter } from './scope';
import { RUNS_WITH_TITLE, ticketLink, toRunWithTitle, type RunWithTitle, type TicketLink } from './runs';

export type RunningCard = {
  runId: number;
  watchId: number | null;
  watchTitle: string | null;
  adhocPrompt: string | null;
  ticket: TicketLink | null;
  repository: string;
  trigger: Trigger;
  reason: string;
  startedAt: number;
  timeoutMs: number;
  cancelRequested: boolean;
};

export type QueueRow = {
  position: number;
  runId: number;
  priority: number;
  trigger: Trigger;
  watchId: number | null;
  watchTitle: string | null;
  adhocPrompt: string | null;
  ticket: TicketLink | null;
  repository: string;
  queuedAt: number;
  reason: string;
};

export function runningRuns({ db }: ReadDeps): RunWithTitle[] {
  return db
    .prepare(`${RUNS_WITH_TITLE} WHERE r.status = 'running' ORDER BY r.started_at, r.id`)
    .all()
    .map(toRunWithTitle);
}

export function toRunningCard(run: RunWithTitle, deps: ReadDeps): RunningCard {
  return {
    runId: run.id,
    watchId: run.watchId,
    watchTitle: run.watchTitle,
    adhocPrompt: run.adhocPrompt,
    ticket: ticketLink(run, deps.config, deps.repositories),
    repository: run.repository,
    trigger: run.trigger,
    reason: run.reason,
    startedAt: run.startedAt ?? run.queuedAt,
    timeoutMs: configOf(deps, run.repository).runs.timeoutMs,
    cancelRequested: run.cancelRequestedAt !== null,
  };
}

export function waitingRows(deps: ReadDeps): QueueRow[] {
  return deps.db
    .prepare(`${RUNS_WITH_TITLE} WHERE r.status = 'queued' ORDER BY r.priority, r.queued_at, r.id`)
    .all()
    .map((row, i) => {
      const run = toRunWithTitle(row);
      return {
        position: i + 1,
        runId: run.id,
        priority: run.priority,
        trigger: run.trigger,
        watchId: run.watchId,
        watchTitle: run.watchTitle,
        adhocPrompt: run.adhocPrompt,
        ticket: ticketLink(run, deps.config, deps.repositories),
        repository: run.repository,
        queuedAt: run.queuedAt,
        reason: run.reason,
      };
    });
}

// Queue positions stay global: the queue is ordered across all Projects, so a Project sees its real place in line.
export function queueView(deps: ReadDeps, scope: ProjectScope = null): { running: RunningCard[]; waiting: QueueRow[] } {
  const inScope = scopeFilter(deps, scope);
  return {
    running: runningRuns(deps)
      .filter((run) => inScope(run.repository))
      .map((run) => toRunningCard(run, deps)),
    waiting: waitingRows(deps).filter((row) => inScope(row.repository)),
  };
}
