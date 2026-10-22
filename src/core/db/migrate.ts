import type { Database } from './open';
import { migrations } from './migrations/index';

export function migrate(db: Database): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.pragma('user_version', { simple: true }) as number;
    for (const { version, sql } of ordered) {
      if (version <= current) continue;
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
