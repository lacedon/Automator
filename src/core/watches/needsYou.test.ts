import { afterEach, describe, expect, test } from 'vitest';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import type { Database } from '../db/open';
import { toWatch } from '../db/rows';
import { closeWatch, enterNeedsYou } from './needsYou';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  return t.db;
}

const now = Date.parse('2026-10-21T11:00:00');

function watch(db: Database, id: number) {
  return toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));
}

function insertRun(db: Database, watchId: number, status: 'queued' | 'finished'): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
       VALUES (?, 'pages', ?, 'schedule', 1, 'r', 'm', ?)`,
    )
    .run(watchId, status, now);
  return Number(info.lastInsertRowid);
}

describe('enterNeedsYou', () => {
  test('enterNeedsYou on closed watch returns null', () => {
    const db = setup();
    const id = insertWatch(db, { state: 'closed' });
    expect(enterNeedsYou(db, { watchId: id, runId: null, reason: 'x', now, teamsEnabled: true })).toBeNull();
    expect(watch(db, id).state).toBe('closed');
    expect(db.prepare('SELECT count(*) AS n FROM needs_you_events').get()).toEqual({ n: 0 });
  });

  test('enterNeedsYou sets fields and inserts pending or disabled event', () => {
    const db = setup();
    const a = insertWatch(db);
    db.prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(now, a);
    const runId = insertRun(db, a, 'finished');
    const pending = enterNeedsYou(db, { watchId: a, runId, reason: 'help', now, teamsEnabled: true });
    expect(pending).toMatchObject({
      watchId: a,
      runId,
      reason: 'help',
      createdAt: now,
      teamsStatus: 'pending',
      teamsError: null,
    });
    expect(watch(db, a)).toMatchObject({
      state: 'needs_you',
      needsYouReason: 'help',
      needsYouSince: now,
      needsYouRunId: runId,
      nextCheckAt: null,
      updatedAt: now,
    });

    const b = insertWatch(db, { state: 'paused' });
    const disabled = enterNeedsYou(db, { watchId: b, runId: null, reason: 'auth', now, teamsEnabled: false });
    expect(disabled).toMatchObject({ watchId: b, runId: null, teamsStatus: 'disabled' });
    expect(watch(db, b)).toMatchObject({ state: 'needs_you', needsYouReason: 'auth', needsYouRunId: null });
  });
});

describe('closeWatch', () => {
  test('closeWatch removes queued row', () => {
    const db = setup();
    const id = insertWatch(db);
    insertRun(db, id, 'queued');
    const finished = insertRun(db, id, 'finished');
    closeWatch(db, id, 'merged', now);
    expect(watch(db, id)).toMatchObject({ state: 'closed', closedReason: 'merged', closedAt: now, nextCheckAt: null });
    expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: finished }]);
  });
});
