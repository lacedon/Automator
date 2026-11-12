import { toRun } from '../db/rows';
import type { Config } from '../config/schema';
import type {
  Interrupted,
  ProjectScope,
  Outcome,
  ProviderName,
  ResultStatus,
  Run,
  RunError,
  RunStatus,
  Trigger,
} from '../domain/types';
import { tryParseUrl } from '../domain/targets';
import { jiraBrowseUrl } from '../prechecks/jiraClient';
import type { RepositoryService } from '../repositories/repositoryService';
import type { ReadDeps } from './deps';
import { scopeFilter } from './scope';

export type TicketLink = { key: string; title: string | null; url: string | null };

export function ticketLink(
  run: Pick<Run, 'repository' | 'ticketKey' | 'ticketTitle'>,
  config: Config,
  repositories: RepositoryService,
): TicketLink | null {
  if (run.ticketKey === null) return null;
  const suppliedUrl = tryParseUrl(run.ticketKey);
  return {
    key: run.ticketKey,
    title: run.ticketTitle,
    url:
      suppliedUrl === null
        ? jiraBrowseUrl(config, repositories.get(run.repository), run.ticketKey)
        : suppliedUrl.protocol === 'http:' || suppliedUrl.protocol === 'https:'
          ? run.ticketKey
          : null,
  };
}

export type RunRow = {
  id: number;
  watchId: number | null;
  watchTitle: string | null;
  adhocPrompt: string | null;
  ticket: TicketLink | null;
  repository: string;
  provider: ProviderName;
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
  closedAt: number | null;
  summary: string | null;
  error: RunError | null;
  transcriptPath: string | null;
  resultPath: string | null;
};

export type RunFilter = {
  q?: string;
  startedFrom?: number;
  startedBefore?: number;
  outcome?: Outcome | 'error';
  trigger?: Trigger;
  repository?: string;
  project?: ProjectScope;
  limit?: number;
};

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

export function toRunRow(run: RunWithTitle, config: Config, repositories: RepositoryService): RunRow {
  return {
    id: run.id,
    watchId: run.watchId,
    watchTitle: run.watchTitle,
    adhocPrompt: run.adhocPrompt,
    ticket: ticketLink(run, config, repositories),
    repository: run.repository,
    provider: run.provider,
    trigger: run.trigger,
    status: run.status,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    tookMs: tookMs(run),
    outcome: run.outcome,
    resultStatus: run.resultStatus,
    interrupted: run.interrupted,
    closedAt: run.closedAt,
    summary: run.summary,
    error: run.error,
    transcriptPath: run.transcriptPath,
    resultPath: run.resultPath,
  };
}

// A chat is an Ad-hoc run with its follow-up Runs; it is listed once, as its newest Run, titled by its first request.
// Runs created by an Automation are only listed on the Automation's own page.
export function runList(deps: ReadDeps, f: RunFilter): RunRow[] {
  const { db, config } = deps;
  const inScope = scopeFilter(deps, f.project ?? null);
  const runs = db.prepare(`${RUNS_WITH_TITLE} WHERE r.watch_id IS NULL ORDER BY r.id`).all().map(toRunWithTitle);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const followUp = new Map<number, RunWithTitle>();
  for (const run of runs) if (run.parentRunId !== null && byId.has(run.parentRunId)) followUp.set(run.parentRunId, run);

  const query = f.q?.trim().toLowerCase();
  const matches = (run: RunWithTitle) =>
    [
      `#${run.id}`,
      run.watchTitle,
      run.adhocPrompt,
      run.ticketKey,
      run.ticketTitle,
      run.summary,
      run.error?.message,
    ].some((value) => value != null && String(value).toLowerCase().includes(query!));
  const rows: RunRow[] = [];
  for (const root of runs) {
    if (root.parentRunId !== null && byId.has(root.parentRunId)) continue;
    const chain = [root];
    for (let next = followUp.get(root.id); next !== undefined && !chain.includes(next); next = followUp.get(next.id))
      chain.push(next);
    const tip = chain.findLast((run) => run.status !== 'queued');
    if (tip === undefined) continue;
    const started = tip.startedAt ?? tip.queuedAt;
    if (
      !inScope(tip.repository) ||
      (f.trigger !== undefined && tip.trigger !== f.trigger) ||
      (f.repository !== undefined && tip.repository !== f.repository) ||
      (f.outcome !== undefined && (f.outcome === 'error' ? tip.resultStatus !== 'error' : tip.outcome !== f.outcome)) ||
      (f.startedFrom !== undefined && started < f.startedFrom) ||
      (f.startedBefore !== undefined && started >= f.startedBefore) ||
      (query && !chain.some(matches))
    )
      continue;
    rows.push(toRunRow({ ...tip, adhocPrompt: root.adhocPrompt ?? tip.adhocPrompt }, config, deps.repositories));
  }
  return rows.sort((a, b) => b.id - a.id).slice(0, f.limit);
}
