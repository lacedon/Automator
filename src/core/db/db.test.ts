import type { Database } from './open';
import { afterEach, describe, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { migrate } from './migrate';
import { toNeedsYouEvent, toRun, toWatch } from './rows';

const cleanups: (() => void)[] = [];

function setup(): Database {
  const t = tempDb();
  cleanups.push(t.cleanup);
  return t.db;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const T = Date.parse('2026-10-21T10:00:00');

function insertWatch(db: Database, state = 'active', target = 'gitlab:gitlab.example.com/g/p!1'): number {
  const info = db
    .prepare(
      `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, created_at, updated_at)
       VALUES ('mr', 'https://gitlab.example.com/g/p/-/merge_requests/1', ?, 'pages', 'Title', ?, ?, ?)`,
    )
    .run(target, state, T, T);
  return Number(info.lastInsertRowid);
}

function insertRun(db: Database, watchId: number | null, status: string): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
       VALUES (?, 'pages', ?, 'schedule', 1, 'new comment', 'm', ?)`,
    )
    .run(watchId, status, T);
  return Number(info.lastInsertRowid);
}

function constraintCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('db', () => {
  test('migrate is idempotent and sets user_version 1', () => {
    const db = setup();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .pluck()
      .all();
    expect(tables).toEqual(['meta', 'needs_you_events', 'runs', 'watches', 'worker_lock']);
  });

  test('pragmas applied', () => {
    const db = setup();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  test('rejects second non-closed watch for same target and repository', () => {
    const db = setup();
    insertWatch(db, 'active');
    expect(constraintCode(() => insertWatch(db, 'paused'))).toBe('SQLITE_CONSTRAINT_UNIQUE');

    const other = setup();
    insertWatch(other, 'closed');
    expect(() => insertWatch(other, 'active')).not.toThrow();
  });

  test('rejects invalid enum values', () => {
    const db = setup();
    expect(constraintCode(() => insertWatch(db, 'bogus'))).toBe('SQLITE_CONSTRAINT_CHECK');
    const watchId = insertWatch(db);
    expect(constraintCode(() => insertRun(db, watchId, 'cancelled'))).toBe('SQLITE_CONSTRAINT_CHECK');
  });

  test('allows only one queued run per watch', () => {
    const db = setup();
    const a = insertWatch(db, 'active', 'a');
    const b = insertWatch(db, 'active', 'b');
    insertRun(db, a, 'queued');
    expect(constraintCode(() => insertRun(db, a, 'queued'))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(() => insertRun(db, b, 'queued')).not.toThrow();
    expect(() => insertRun(db, null, 'queued')).not.toThrow();
    expect(() => insertRun(db, null, 'queued')).not.toThrow();
    expect(() => insertRun(db, a, 'finished')).not.toThrow();
  });

  test('allows only one running run', () => {
    const db = setup();
    const a = insertWatch(db, 'active', 'a');
    const b = insertWatch(db, 'active', 'b');
    insertRun(db, a, 'running');
    expect(constraintCode(() => insertRun(db, b, 'running'))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(constraintCode(() => insertRun(db, null, 'running'))).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });

  test('deleting a watch cascades runs and needs_you_events', () => {
    const db = setup();
    const watchId = insertWatch(db);
    const runId = insertRun(db, watchId, 'finished');
    const adhocId = insertRun(db, null, 'finished');
    db.prepare(
      `INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status) VALUES (?, ?, 'r', ?, 'pending')`,
    ).run(watchId, runId, T);
    db.prepare('DELETE FROM watches WHERE id = ?').run(watchId);
    expect(db.prepare('SELECT id FROM runs').pluck().all()).toEqual([adhocId]);
    expect(db.prepare('SELECT COUNT(*) FROM needs_you_events').pluck().get()).toBe(0);
  });

  test('maps rows to domain objects', () => {
    const db = setup();
    const watchId = insertWatch(db);
    db.prepare(`UPDATE watches SET cursor_json = ?, interval_ms = 60000 WHERE id = ?`).run(
      JSON.stringify({ lastNoteId: 5, handledPipelineId: null, handledConflictSha: null }),
      watchId,
    );
    const watch = toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId));
    expect(watch).toMatchObject({
      id: watchId,
      kind: 'mr',
      normalizedTarget: 'gitlab:gitlab.example.com/g/p!1',
      state: 'active',
      intervalMs: 60000,
      model: null,
      cursor: { lastNoteId: 5, handledPipelineId: null, handledConflictSha: null },
      checkFailures: 0,
      createdAt: T,
    });

    const runId = insertRun(db, watchId, 'finished');
    db.prepare(`UPDATE runs SET review_unresolved = 1, error_json = ?, result_status = 'error' WHERE id = ?`).run(
      JSON.stringify({ code: 'TIMEOUT', message: 'took too long' }),
      runId,
    );
    const run = toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
    expect(run).toMatchObject({
      id: runId,
      watchId,
      status: 'finished',
      reviewUnresolved: true,
      resultStatus: 'error',
      error: { code: 'TIMEOUT', message: 'took too long' },
      cursorCandidate: null,
      outcome: null,
    });

    db.prepare(
      `INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status) VALUES (?, NULL, 'r', ?, 'disabled')`,
    ).run(watchId, T);
    const event = toNeedsYouEvent(db.prepare('SELECT * FROM needs_you_events').get());
    expect(event).toEqual({
      id: 1,
      watchId,
      runId: null,
      reason: 'r',
      createdAt: T,
      teamsStatus: 'disabled',
      teamsError: null,
    });
  });
});
