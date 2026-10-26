import { toRun } from '../db/rows';
import type { Config } from '../config/schema';
import type { Interrupted, Outcome, ResultStatus, Run, RunError, RunStatus, Trigger } from '../domain/types';
import { jiraBrowseUrl } from '../prechecks/jiraClient';
import type { ReadDeps } from './deps';

export type TicketLink = { key: string; title: string | null; url: string | null };

export function ticketLink(
  run: Pick<Run, 'repository' | 'ticketKey' | 'ticketTitle'>,
  config: Config,
): TicketLink | null {
  if (run.ticketKey === null) return null;
  return { key: run.ticketKey, title: run.ticketTitle, url: jiraBrowseUrl(config, run.repository, run.ticketKey) };
}

export type RunRow = {
  id: number;
  watchId: number | null;
  watchTitle: string | null;
  adhocPrompt: string | null;
  ticket: TicketLink | null;
  repository: string;
  trigger: Trigger;
  status: RunStatus;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  // null while running and when the Run ended before Copilot started (UI shows "—").
  tookMs: number | null;
  outcome: Outcome | null;
  resultStatus: ResultStatus | null;
  interrupted: Interrupted | null;
  summary: string | null;
  error: RunError | null;
  transcriptPath: string | null;
  resultPath: string | null;
};

export type RunFilter = { outcome?: Outcome | 'error'; trigger?: Trigger; repository?: string };

export const RUNS_WITH_TITLE =
  'SELECT r.*, w.title AS watch_title FROM runs r LEFT JOIN watches w ON w.id = r.watch_id';

export type RunWithTitle = Run & { watchTitle: string | null };

export function toRunWithTitle(row: unknown): RunWithTitle {
  return { ...toRun(row), watchTitle: (row as { watch_title: string | null }).watch_title };
}

export function tookMs(run: Run): number | null {
  if (run.pid === null || run.startedAt === null || run.endedAt === null) return null;
  return run.endedAt - run.startedAt;
}

export function toRunRow(run: RunWithTitle, config: Config): RunRow {
  return {
    id: run.id,
    watchId: run.watchId,
    watchTitle: run.watchTitle,
    adhocPrompt: run.adhocPrompt,
    ticket: ticketLink(run, config),
    repository: run.repository,
    trigger: run.trigger,
    status: run.status,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    tookMs: tookMs(run),
    outcome: run.outcome,
    resultStatus: run.resultStatus,
    interrupted: run.interrupted,
    summary: run.summary,
    error: run.error,
    transcriptPath: run.transcriptPath,
    resultPath: run.resultPath,
  };
}

export function runList({ db, config }: ReadDeps, f: RunFilter): RunRow[] {
  return db
    .prepare(
      `${RUNS_WITH_TITLE}
       WHERE r.status <> 'queued'
         AND (@trigger IS NULL OR r.trigger = @trigger)
         AND (@repository IS NULL OR r.repository = @repository)
         AND (@outcome IS NULL OR (@outcome = 'error' AND r.result_status = 'error') OR r.outcome = @outcome)
       ORDER BY r.id DESC`,
    )
    .all({ outcome: f.outcome ?? null, trigger: f.trigger ?? null, repository: f.repository ?? null })
    .map((row) => toRunRow(toRunWithTitle(row), config));
}
