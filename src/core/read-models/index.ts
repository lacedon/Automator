import type { Watch } from '../domain/types';
import { adhocView, type AdhocRow } from './adhoc';
import type { ReadDeps } from './deps';
import { formOptions, type FormOptions } from './formOptions';
import { homeView, type HomeView } from './home';
import { nextCheckText, type NextCheck, type NextCheckContext } from './nextCheck';
import { queueView, type QueueRow, type RunningCard } from './queue';
import { runDetail, type RunDetailView } from './runDetail';
import { runList, type RunFilter, type RunRow } from './runs';
import { watchDetail, type WatchDetailView } from './watchDetail';
import { watchList, type WatchFilter, type WatchListView } from './watches';

export type { ReadDeps } from './deps';
export type { AdhocRow } from './adhoc';
export type { TicketLink } from './runs';
export type { FormOptions } from './formOptions';
export type { HomeView, NeedsYouCard } from './home';
export type { NextCheck, NextCheckContext, NextCheckKind } from './nextCheck';
export type { QueueRow, RunningCard } from './queue';
export type { FileView, RunDetailView } from './runDetail';
export type { RunFilter, RunRow } from './runs';
export type { WatchDetailView, WatchSettings } from './watchDetail';
export type { LastRun, WatchFilter, WatchListView, WatchRow } from './watches';

export interface ReadModels {
  homeView(): HomeView;
  watchList(f: WatchFilter): WatchListView;
  watchDetail(id: number): WatchDetailView | null;
  queueView(): { running: RunningCard | null; waiting: QueueRow[] };
  runList(f: RunFilter): RunRow[];
  runDetail(id: number): Promise<RunDetailView | null>;
  adhocView(): { rows: AdhocRow[] };
  formOptions(): FormOptions;
  nextCheckText(w: Watch, ctx: NextCheckContext): NextCheck;
  navCounts(): { watches: number; queued: number };
}

export function createReadModels(deps: ReadDeps): ReadModels {
  return {
    homeView: () => homeView(deps),
    watchList: (f) => watchList(deps, f),
    watchDetail: (id) => watchDetail(deps, id),
    queueView: () => queueView(deps),
    runList: (f) => runList(deps, f),
    runDetail: (id) => runDetail(deps, id),
    adhocView: () => adhocView(deps),
    formOptions: () => formOptions(deps),
    nextCheckText,
    navCounts: () => {
      const count = (sql: string) => (deps.db.prepare(sql).get() as { n: number }).n;
      return {
        watches: count('SELECT count(*) AS n FROM watches'),
        queued: count("SELECT count(*) AS n FROM runs WHERE status = 'queued'"),
      };
    },
  };
}
