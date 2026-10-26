import { toNeedsYouEvent, toWatch } from '../db/rows';
import { intervalFor } from '../domain/schedule';
import type { Cursor, InitialReview, JiraCursor, MrCursor, NeedsYouEvent, Watch } from '../domain/types';
import type { WatchAction } from '../domain/watchState';
import type { ReadDeps } from './deps';
import type { NextCheck } from './nextCheck';
import { toRunningCard, type RunningCard } from './queue';
import { RUNS_WITH_TITLE, toRunRow, toRunWithTitle, type RunRow } from './runs';
import { actionsFor, nextCheckFor, nextCheckSource } from './watches';

export type WatchSettings = {
  repository: string;
  folder: string | null;
  intervalMs: number;
  intervalIsDefault: boolean;
  model: string;
  modelIsDefault: boolean;
  initialReview: InitialReview;
  initialReviewIsDefault: boolean;
  createdAt: number;
};

export type WatchDetailView = {
  watch: Watch;
  actions: WatchAction[];
  running: RunningCard | null;
  nextCheck: NextCheck;
  settings: WatchSettings;
  lastHandled: string[];
  needsYouEvent: NeedsYouEvent | null;
  runs: RunRow[];
};

const orNone = (v: string | number | null) => (v === null || v === 0 ? 'none' : String(v));

function lastHandledLines(kind: Watch['kind'], cursor: Cursor | null): string[] {
  if (cursor === null) return ['Not checked yet'];
  if (kind === 'mr') {
    const c = cursor as MrCursor;
    return [
      `Last comment: ${c.lastNoteId ? `note #${c.lastNoteId}` : 'none'}`,
      `Pipeline: ${c.handledPipelineId === null ? 'none' : `#${c.handledPipelineId}`}`,
      `Conflicts: ${orNone(c.handledConflictSha)}`,
    ];
  }
  if (kind === 'jira') {
    const c = cursor as JiraCursor;
    return [`Last change: ${orNone(c.lastChangelogId)}`, `Last comment: ${orNone(c.lastCommentId)}`];
  }
  return [];
}

export function watchDetail(deps: ReadDeps, id: number): WatchDetailView | null {
  const { db, config } = deps;
  const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
  if (row === undefined) return null;
  const watch = toWatch(row);
  const src = nextCheckSource(deps);
  const running = src.running?.watchId === watch.id ? src.running : null;
  const event = db.prepare('SELECT * FROM needs_you_events WHERE watch_id = ? ORDER BY id DESC LIMIT 1').get(id);
  const runs = db
    .prepare(`${RUNS_WITH_TITLE} WHERE r.watch_id = ? AND r.status <> 'queued' ORDER BY r.id DESC`)
    .all(id)
    .map((r) => toRunRow(toRunWithTitle(r), deps.config));

  return {
    watch,
    actions: actionsFor(watch, src.running),
    running: toRunningCard(running, deps),
    nextCheck: nextCheckFor(watch, src, deps),
    settings: {
      repository: watch.repository,
      folder: config.repositories[watch.repository]?.folder ?? null,
      intervalMs: intervalFor(watch, config),
      intervalIsDefault: watch.intervalMs === null,
      model: watch.model ?? config.runs.defaultModel,
      modelIsDefault: watch.model === null,
      initialReview: watch.initialReview ?? config.runs.initialReview,
      initialReviewIsDefault: watch.initialReview === null,
      createdAt: watch.createdAt,
    },
    lastHandled: lastHandledLines(watch.kind, watch.cursor),
    needsYouEvent: event === undefined ? null : toNeedsYouEvent(event),
    runs,
  };
}
