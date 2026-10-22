import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { WatchState } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { CleanupService } from './cleanupService';

const DAY = 86_400_000;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(cleanup: Partial<Config['cleanup']> = {}) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const config = testConfig({ cleanup });
  cleanups.push(() => fs.rmSync(config.configDir, { recursive: true, force: true }));
  const dataDir = new DataDir(config.dataDir);
  const service = new CleanupService({ db: t.db, clock, config, dataDir });
  return { db: t.db, clock, dataDir, service };
}

function watchWithState(db: Database, state: WatchState, closedAt: number | null = null): number {
  const id = insertWatch(db, { state });
  db.prepare('UPDATE watches SET closed_at = ? WHERE id = ?').run(closedAt, id);
  return id;
}

function insertRun(db: Database, dataDir: DataDir, watchId: number | null): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
       VALUES (?, 'pages', 'finished', ?, 0, 'test', 'm', 0)`,
    )
    .run(watchId, watchId === null ? 'adhoc' : 'schedule');
  const id = Number(info.lastInsertRowid);
  fs.writeFileSync(path.join(dataDir.ensureRunDir(id), 'result.json'), '{}');
  return id;
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('CleanupService', () => {
  test('deletes watches closed at least 30 days with runs, events and run dirs', () => {
    const { db, clock, dataDir, service } = setup();
    const watchId = watchWithState(db, 'closed', clock.now() - 30 * DAY);
    const runId = insertRun(db, dataDir, watchId);
    const eventId = Number(
      db
        .prepare("INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status) VALUES (?, ?, 'r', 0, 'sent')")
        .run(watchId, runId).lastInsertRowid,
    );
    fs.mkdirSync(dataDir.notifyDir, { recursive: true });
    for (const file of [dataDir.notifyTranscriptPath(eventId), dataDir.notifyLogPath(eventId)]) fs.writeFileSync(file, 'x');

    expect(service.run()).toEqual({ deletedWatches: 1, deletedAttempts: 0 });
    expect(fs.readdirSync(dataDir.notifyDir)).toEqual([]);
    expect(count(db, 'watches')).toBe(0);
    expect(count(db, 'runs')).toBe(0);
    expect(count(db, 'needs_you_events')).toBe(0);
    expect(fs.existsSync(dataDir.runDir(runId))).toBe(false);
  });

  test('keeps closed 29 days', () => {
    const { db, clock, dataDir, service } = setup();
    const runId = insertRun(db, dataDir, watchWithState(db, 'closed', clock.now() - 29 * DAY));

    expect(service.run().deletedWatches).toBe(0);
    expect(count(db, 'watches')).toBe(1);
    expect(fs.existsSync(dataDir.runDir(runId))).toBe(true);
  });

  test('never deletes active, paused, needs_you', () => {
    const { db, clock, dataDir, service } = setup();
    const old = clock.now() - 365 * DAY;
    const runIds = (['active', 'paused', 'needs_you'] as const).map((state) =>
      insertRun(db, dataDir, watchWithState(db, state, old)),
    );

    expect(service.run().deletedWatches).toBe(0);
    expect(count(db, 'watches')).toBe(3);
    expect(count(db, 'runs')).toBe(3);
    for (const id of runIds) expect(fs.existsSync(dataDir.runDir(id))).toBe(true);
  });

  test('keeps adhoc runs', () => {
    const { db, clock, dataDir, service } = setup();
    insertRun(db, dataDir, watchWithState(db, 'closed', clock.now() - 60 * DAY));
    const adhocId = insertRun(db, dataDir, null);

    expect(service.run().deletedWatches).toBe(1);
    expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: adhocId }]);
    expect(fs.existsSync(dataDir.runDir(adhocId))).toBe(true);
  });

  test('removes attempt files older than retention', () => {
    const { clock, dataDir, service } = setup();
    expect(service.run().deletedAttempts).toBe(0);

    fs.mkdirSync(dataDir.attemptsDir, { recursive: true });
    const write = (name: string, ageDays: number) => {
      const file = path.join(dataDir.attemptsDir, name);
      fs.writeFileSync(file, '{}');
      const t = new Date(clock.now() - ageDays * DAY);
      fs.utimesSync(file, t, t);
      return file;
    };
    const oldJson = write('old.json', 31);
    const freshJson = write('fresh.json', 29);
    const oldOther = write('old.txt', 31);

    expect(service.run().deletedAttempts).toBe(1);
    expect(fs.existsSync(oldJson)).toBe(false);
    expect(fs.existsSync(freshJson)).toBe(true);
    expect(fs.existsSync(oldOther)).toBe(true);
  });

  test('isDue after 7 days; disabled config is never due', () => {
    const { db, clock, service } = setup();
    expect(service.isDue()).toBe(true);
    service.run();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'last_cleanup_at'").get()).toEqual({
      value: String(clock.now()),
    });
    expect(service.isDue()).toBe(false);
    clock.advance(7 * DAY - 1);
    expect(service.isDue()).toBe(false);
    clock.advance(1);
    expect(service.isDue()).toBe(true);

    expect(setup({ enabled: false }).service.isDue()).toBe(false);
  });
});
