import { toWatch } from '../db/rows';
import { intervalFor } from '../domain/schedule';
import type {
  Interrupted,
  ProjectScope,
  Outcome,
  ResultStatus,
  Run,
  Watch,
  WatchKind,
  WatchState,
} from '../domain/types';
import { allowedActions, type WatchAction } from '../domain/watchState';
import { configOf, type ReadDeps } from './deps';
import { scopeFilter } from './scope';
import { nextCheckText, type NextCheck } from './nextCheck';
import { runningRuns, waitingRows } from './queue';
import type { RunWithTitle } from './runs';

export type LastRun = {
  id: number;
  outcome: Outcome | null;
  resultStatus: ResultStatus | null;
  interrupted: Interrupted | null;
  endedAt: number | null;
};

export type WatchRow = {
  id: number;
  state: WatchState;
  kind: WatchKind;
  title: string;
  targetUrl: string;
  repository: string;
  everyMs: number;
  nextCheck: NextCheck;
  lastRun: LastRun | null;
  needsYouReason: string | null;
  running: boolean;
  actions: WatchAction[];
};

export type WatchFilter = {
  state?: WatchState;
  kind?: WatchKind;
  repository?: string;
  q?: string;
  project?: ProjectScope;
};

export type WatchListView = { counts: Record<'all' | WatchState, number>; jiraNotice: boolean; rows: WatchRow[] };

const STATE_ORDER: Record<WatchState, number> = { needs_you: 0, active: 1, paused: 2, closed: 3 };

export function actionsFor(watch: Watch, running: Run | null): WatchAction[] {
  const isRunning = running !== null && running.watchId === watch.id;
  return allowedActions(watch.state).filter((a) => !(a === 'delete' && isRunning));
}

export type NextCheckSource = { running: Map<number, RunWithTitle>; queuedPos(watchId: number): number | null };

export function nextCheckSource(deps: ReadDeps): NextCheckSource {
  const positions = new Map<number, number>();
  for (const row of waitingRows(deps)) if (row.watchId !== null) positions.set(row.watchId, row.position);
  const running = new Map<number, RunWithTitle>();
  for (const run of runningRuns(deps)) if (run.watchId !== null) running.set(run.watchId, run);
  return { running, queuedPos: (id) => positions.get(id) ?? null };
}

export function nextCheckFor(watch: Watch, src: NextCheckSource, deps: ReadDeps): NextCheck {
  return nextCheckText(watch, {
    now: deps.clock.now(),
    running: src.running.get(watch.id) ?? null,
    queuedPos: src.queuedPos(watch.id),
    config: configOf(deps, watch.repository),
  });
}

function lastRuns({ db }: ReadDeps): Map<number, LastRun> {
  const rows = db
    .prepare(
      `SELECT id, watch_id, outcome, result_status, interrupted, ended_at FROM runs
       WHERE id IN (SELECT max(id) FROM runs WHERE status = 'finished' AND watch_id IS NOT NULL GROUP BY watch_id)`,
    )
    .all() as {
    id: number;
    watch_id: number;
    outcome: Outcome | null;
    result_status: ResultStatus | null;
    interrupted: Interrupted | null;
    ended_at: number | null;
  }[];
  return new Map(
    rows.map((r) => [
      r.watch_id,
      { id: r.id, outcome: r.outcome, resultStatus: r.result_status, interrupted: r.interrupted, endedAt: r.ended_at },
    ]),
  );
}

export function watchList(deps: ReadDeps, f: WatchFilter): WatchListView {
  const { db } = deps;
  const q = f.q?.trim().toLowerCase() || null;
  const inScope = scopeFilter(deps, f.project ?? null);
  const watches = db
    .prepare(
      `SELECT * FROM watches
       WHERE (@kind IS NULL OR kind = @kind)
         AND (@repository IS NULL OR repository = @repository)
         AND (@q IS NULL OR instr(lower(COALESCE(name, title)), @q) > 0 OR instr(lower(title), @q) > 0 OR instr(lower(target_url), @q) > 0)`,
    )
    .all({ kind: f.kind ?? null, repository: f.repository ?? null, q })
    .map(toWatch)
    .filter((w) => inScope(w.repository));

  const counts: WatchListView['counts'] = { all: watches.length, needs_you: 0, active: 0, paused: 0, closed: 0 };
  for (const w of watches) counts[w.state] += 1;

  const jiraNotice = (
    db.prepare("SELECT DISTINCT repository FROM watches WHERE kind = 'jira' AND state <> 'closed'").all() as {
      repository: string;
    }[]
  ).some(({ repository }) => !configOf(deps, repository).jira.enabled);

  const src = nextCheckSource(deps);
  const last = lastRuns(deps);
  const rows = watches
    .filter((w) => f.state === undefined || w.state === f.state)
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        (a.name ?? a.title).localeCompare(b.name ?? b.title) ||
        a.id - b.id,
    )
    .map((w) => ({
      id: w.id,
      state: w.state,
      kind: w.kind,
      title: w.name ?? w.title,
      targetUrl: w.targetUrl,
      repository: w.repository,
      everyMs: intervalFor(w, configOf(deps, w.repository)),
      nextCheck: nextCheckFor(w, src, deps),
      lastRun: last.get(w.id) ?? null,
      needsYouReason: w.needsYouReason,
      running: src.running.has(w.id),
      actions: actionsFor(w, src.running.get(w.id) ?? null),
    }));
  return { counts, jiraNotice, rows };
}
