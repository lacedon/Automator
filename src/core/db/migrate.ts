import type { Database } from './open';
import { migrations } from './migrations/index';

export function migrate(db: Database): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const current = db.pragma('user_version', { simple: true }) as number;
  // Rebuilding a table that other tables reference must not fire their ON DELETE actions, and
  // foreign_keys can only be changed outside a transaction.
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  const rebuilds = ordered.some((m) => m.version > current && m.rebuildsTables === true);
  if (rebuilds && foreignKeys === 1) db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = db.pragma('user_version', { simple: true }) as number;
      for (const { version, sql } of ordered) {
        if (version <= applied) continue;
        db.exec(sql);
        db.pragma(`user_version = ${version}`);
      }
      if (rebuilds) {
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) throw new Error('Migration left foreign key violations');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    if (rebuilds && foreignKeys === 1) db.pragma('foreign_keys = ON');
  }
}
