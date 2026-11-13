import type { WatchKind } from '../domain/types';
import type { ReadDeps } from './deps';
import { scopeFilter } from './scope';
import type { ProjectScope } from '../domain/types';
import { runningRuns, toRunningCard, type RunningCard } from './queue';
import { RUNS_WITH_TITLE, toRunRow, toRunWithTitle, type RunRow } from './runs';

export type NeedsYouCard = {
  watchId: number;
  title: string;
  kind: WatchKind;
  repository: string;
  reason: string | null;
  since: number | null;
  runId: number | null;
};

export type HomeView = { needsYou: NeedsYouCard[]; running: RunningCard[]; recent: RunRow[] };

const RECENT_LIMIT = 10;

export function homeView(deps: ReadDeps, scope: ProjectScope = null): HomeView {
  const { db } = deps;
  const inScope = scopeFilter(deps, scope);
  const needsYou = db
    .prepare(
      `SELECT id, COALESCE(name, title) AS title, kind, repository, needs_you_reason, needs_you_since, needs_you_run_id FROM watches
       WHERE state = 'needs_you' ORDER BY needs_you_since DESC, id DESC`,
    )
    .all()
    .filter((row) => inScope((row as { repository: string }).repository))
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        watchId: r.id as number,
        title: r.title as string,
        kind: r.kind as WatchKind,
        repository: r.repository as string,
        reason: r.needs_you_reason as string | null,
        since: r.needs_you_since as number | null,
        runId: r.needs_you_run_id as number | null,
      };
    });
  const recent = db
    .prepare(`${RUNS_WITH_TITLE} WHERE r.status = 'finished' ORDER BY r.id DESC LIMIT ?`)
    // A Project's runs may be older than the newest runs overall, so scoped views read the whole history.
    .all(scope === null ? RECENT_LIMIT : -1)
    .map(toRunWithTitle)
    .filter((run) => inScope(run.repository))
    .slice(0, RECENT_LIMIT)
    .map((run) => toRunRow(run, deps.config, deps.repositories));
  const running = runningRuns(deps)
    .filter((run) => inScope(run.repository))
    .map((run) => toRunningCard(run, deps));
  return { needsYou, running, recent };
}
