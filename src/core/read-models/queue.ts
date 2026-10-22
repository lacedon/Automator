import type { Trigger } from '../domain/types';
import type { ReadDeps } from './deps';
import { RUNS_WITH_TITLE, toRunWithTitle, type RunWithTitle } from './runs';

export type RunningCard = {
  runId: number;
  watchId: number | null;
  watchTitle: string | null;
  adhocPrompt: string | null;
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
  repository: string;
  queuedAt: number;
  reason: string;
};

export function runningRun({ db }: ReadDeps): RunWithTitle | null {
  const row = db.prepare(`${RUNS_WITH_TITLE} WHERE r.status = 'running'`).get();
  return row ? toRunWithTitle(row) : null;
}

export function toRunningCard(run: RunWithTitle | null, deps: ReadDeps): RunningCard | null {
  if (run === null) return null;
  return {
    runId: run.id,
    watchId: run.watchId,
    watchTitle: run.watchTitle,
    adhocPrompt: run.adhocPrompt,
    repository: run.repository,
    trigger: run.trigger,
    reason: run.reason,
    startedAt: run.startedAt ?? run.queuedAt,
    timeoutMs: deps.config.runs.timeoutMs,
    cancelRequested: run.cancelRequestedAt !== null,
  };
}

export function waitingRows({ db }: ReadDeps): QueueRow[] {
  return db
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
        repository: run.repository,
        queuedAt: run.queuedAt,
        reason: run.reason,
      };
    });
}

export function queueView(deps: ReadDeps): { running: RunningCard | null; waiting: QueueRow[] } {
  return { running: toRunningCard(runningRun(deps), deps), waiting: waitingRows(deps) };
}
