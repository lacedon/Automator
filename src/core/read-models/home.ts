import type { WatchKind } from '../domain/types';
import type { ReadDeps } from './deps';
import { runningRun, toRunningCard, type RunningCard } from './queue';
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

export type HomeView = { needsYou: NeedsYouCard[]; running: RunningCard | null; recent: RunRow[] };

const RECENT_LIMIT = 10;

export function homeView(deps: ReadDeps): HomeView {
  const { db } = deps;
  const needsYou = db
    .prepare(
      `SELECT id, title, kind, repository, needs_you_reason, needs_you_since, needs_you_run_id FROM watches
       WHERE state = 'needs_you' ORDER BY needs_you_since DESC, id DESC`,
    )
    .all()
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
    .all(RECENT_LIMIT)
    .map((row) => toRunRow(toRunWithTitle(row), deps.config));
  return { needsYou, running: toRunningCard(runningRun(deps), deps), recent };
}
