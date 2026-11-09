import type { ProjectScope, Watch } from '../domain/types';
import { scopeFilter } from './scope';
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
export type { ThreadRun, ThreadView } from './thread';
export type { WatchDetailView, WatchSettings } from './watchDetail';
export type { LastRun, WatchFilter, WatchListView, WatchRow } from './watches';

export interface ReadModels {
  homeView(scope?: ProjectScope): HomeView;
  watchList(f: WatchFilter): WatchListView;
  watchDetail(id: number): WatchDetailView | null;
  queueView(scope?: ProjectScope): { running: RunningCard | null; waiting: QueueRow[] };
  runList(f: RunFilter): RunRow[];
  runDetail(id: number): Promise<RunDetailView | null>;
  adhocView(scope?: ProjectScope): { rows: AdhocRow[] };
  formOptions(scope?: ProjectScope): FormOptions;
  nextCheckText(w: Watch, ctx: NextCheckContext): NextCheck;
  navCounts(scope?: ProjectScope): { watches: number; queued: number };
}

export function createReadModels(deps: ReadDeps): ReadModels {
  return {
    homeView: (scope) => homeView(deps, scope),
    watchList: (f) => watchList(deps, f),
    watchDetail: (id) => watchDetail(deps, id),
    queueView: (scope) => queueView(deps, scope),
    runList: (f) => runList(deps, f),
    runDetail: (id) => runDetail(deps, id),
    adhocView: (scope) => adhocView(deps, scope),
    formOptions: (scope) => formOptions(deps, scope),
    nextCheckText,
    navCounts: (scope = null) => {
      const inScope = scopeFilter(deps, scope);
      const repositories = (sql: string) =>
        (deps.db.prepare(sql).all() as { repository: string }[]).map((r) => r.repository);
      return {
        watches: repositories('SELECT repository FROM watches').filter(inScope).length,
        queued: repositories("SELECT repository FROM runs WHERE status = 'queued'").filter(inScope).length,
      };
    },
  };
}
