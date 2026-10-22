import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { Clock } from '../domain/types';
import type { DataDir } from '../files/dataDir';

const DAY_MS = 86_400_000;
const LAST_CLEANUP_KEY = 'last_cleanup_at';

export interface CleanupDeps {
  db: Database;
  clock: Clock;
  config: Config;
  dataDir: DataDir;
}

export class CleanupService {
  constructor(private readonly deps: CleanupDeps) {}

  isDue(): boolean {
    const { enabled, everyDays } = this.deps.config.cleanup;
    if (!enabled) return false;
    const row = this.deps.db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_CLEANUP_KEY) as
      { value: string } | undefined;
    return row === undefined || this.deps.clock.now() - Number(row.value) >= everyDays * DAY_MS;
  }

  run(): { deletedWatches: number; deletedAttempts: number } {
    const { db, clock, config, dataDir } = this.deps;
    const now = clock.now();
    const cutoff = now - config.cleanup.retainClosedDays * DAY_MS;

    const { deletedWatches, runIds, eventIds } = db
      .transaction(() => {
        const watchIds = (
          db.prepare("SELECT id FROM watches WHERE state = 'closed' AND closed_at <= ?").all(cutoff) as { id: number }[]
        ).map((r) => r.id);
        const runIds: number[] = [];
        const eventIds: number[] = [];
        const selectRuns = db.prepare('SELECT id FROM runs WHERE watch_id = ?');
        const selectEvents = db.prepare('SELECT id FROM needs_you_events WHERE watch_id = ?');
        const deleteWatch = db.prepare('DELETE FROM watches WHERE id = ?');
        for (const id of watchIds) {
          for (const r of selectRuns.all(id) as { id: number }[]) runIds.push(r.id);
          for (const e of selectEvents.all(id) as { id: number }[]) eventIds.push(e.id);
          deleteWatch.run(id);
        }
        db.prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(LAST_CLEANUP_KEY, String(now));
        return { deletedWatches: watchIds.length, runIds, eventIds };
      })
      .immediate();

    for (const id of runIds) dataDir.removeRunDir(id);
    for (const id of eventIds) dataDir.removeNotifyFiles(id);

    return { deletedWatches, deletedAttempts: this.removeOldAttempts(cutoff) };
  }

  private removeOldAttempts(cutoff: number): number {
    const dir = this.deps.dataDir.attemptsDir;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    let deleted = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile() || stat.mtimeMs >= cutoff) continue;
      fs.rmSync(file, { force: true });
      deleted += 1;
    }
    return deleted;
  }
}
