import { toWatch } from '../db/rows';
import { intervalFor } from '../domain/schedule';
import type { Interrupted, Outcome, ResultStatus, Run, Watch, WatchKind, WatchState } from '../domain/types';
import { allowedActions, type WatchAction } from '../domain/watchState';
import type { ReadDeps } from './deps';
import { nextCheckText, type NextCheck } from './nextCheck';
import { runningRun, waitingRows } from './queue';
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

export type WatchFilter = { state?: WatchState; kind?: WatchKind; repository?: string; q?: string };

export type WatchListView = { counts: Record<'all' | WatchState, number>; jiraNotice: boolean; rows: WatchRow[] };

const STATE_ORDER: Record<WatchState, number> = { needs_you: 0, active: 1, paused: 2, closed: 3 };

export function actionsFor(watch: Watch, running: Run | null): WatchAction[] {
  const isRunning = running !== null && running.watchId === watch.id;
  return allowedActions(watch.state).filter((a) => !(a === 'delete' && isRunning));
}

export type NextCheckSource = { running: RunWithTitle | null; queuedPos(watchId: number): number | null };

export function nextCheckSource(deps: ReadDeps): NextCheckSource {
  const positions = new Map<number, number>();
  for (const row of waitingRows(deps)) if (row.watchId !== null) positions.set(row.watchId, row.position);
  return { running: runningRun(deps), queuedPos: (id) => positions.get(id) ?? null };
}

export function nextCheckFor(watch: Watch, src: NextCheckSource, deps: ReadDeps): NextCheck {
  return nextCheckText(watch, {
    now: deps.clock.now(),
    running: src.running,
    queuedPos: src.queuedPos(watch.id),
    config: deps.config,
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
  const { db, config } = deps;
  const q = f.q?.trim().toLowerCase() || null;
  const watches = db
    .prepare(
      `SELECT * FROM watches
       WHERE (@kind IS NULL OR kind = @kind)
         AND (@repository IS NULL OR repository = @repository)
         AND (@q IS NULL OR instr(lower(title), @q) > 0 OR instr(lower(target_url), @q) > 0)`,
    )
    .all({ kind: f.kind ?? null, repository: f.repository ?? null, q })
    .map(toWatch);

  const counts: WatchListView['counts'] = { all: watches.length, needs_you: 0, active: 0, paused: 0, closed: 0 };
  for (const w of watches) counts[w.state] += 1;

  const jiraNotice =
    !config.jira.enabled && db.prepare("SELECT 1 FROM watches WHERE kind = 'jira' AND state <> 'closed' LIMIT 1").get() !== undefined;

  const src = nextCheckSource(deps);
  const last = lastRuns(deps);
  const rows = watches
    .filter((w) => f.state === undefined || w.state === f.state)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title) || a.id - b.id)
    .map((w) => ({
      id: w.id,
      state: w.state,
      kind: w.kind,
      title: w.title,
      targetUrl: w.targetUrl,
      repository: w.repository,
      everyMs: intervalFor(w, config),
      nextCheck: nextCheckFor(w, src, deps),
      lastRun: last.get(w.id) ?? null,
      needsYouReason: w.needsYouReason,
      running: src.running?.watchId === w.id,
      actions: actionsFor(w, src.running),
    }));
  return { counts, jiraNotice, rows };
}
