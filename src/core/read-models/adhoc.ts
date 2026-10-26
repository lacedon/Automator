import type { Interrupted, Outcome, ResultStatus, RunStatus } from '../domain/types';
import type { ReadDeps } from './deps';
import { waitingRows } from './queue';
import { toRunRow, toRunWithTitle, RUNS_WITH_TITLE, type TicketLink } from './runs';

export type AdhocRow = {
  id: number;
  prompt: string;
  ticket: TicketLink | null;
  repository: string;
  status: RunStatus;
  queuePosition: number | null;
  outcome: Outcome | null;
  resultStatus: ResultStatus | null;
  interrupted: Interrupted | null;
  summary: string | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  tookMs: number | null;
};

export function adhocView(deps: ReadDeps): { rows: AdhocRow[] } {
  const positions = new Map(waitingRows(deps).map((r) => [r.runId, r.position]));
  const rows = deps.db
    .prepare(`${RUNS_WITH_TITLE} WHERE r.watch_id IS NULL ORDER BY r.id DESC`)
    .all()
    .map((row) => {
      const run = toRunRow(toRunWithTitle(row), deps.config);
      return {
        id: run.id,
        prompt: run.adhocPrompt ?? '',
        ticket: run.ticket,
        repository: run.repository,
        status: run.status,
        queuePosition: positions.get(run.id) ?? null,
        outcome: run.outcome,
        resultStatus: run.resultStatus,
        interrupted: run.interrupted,
        summary: run.summary,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        tookMs: run.tookMs,
      };
    });
  return { rows };
}
