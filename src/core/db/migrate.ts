import fs from 'node:fs';
import type { Database } from './open';

const migrationsDir = new URL('./migrations/', import.meta.url);

function listMigrations(): { version: number; file: URL }[] {
  return fs
    .readdirSync(migrationsDir)
    .map((name) => ({ name, match: /^(\d+)_.+\.sql$/.exec(name) }))
    .filter((m): m is { name: string; match: RegExpExecArray } => m.match !== null)
    .map(({ name, match }) => ({ version: Number(match[1]), file: new URL(name, migrationsDir) }))
    .sort((a, b) => a.version - b.version);
}

export function migrate(db: Database): void {
  const migrations = listMigrations();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.pragma('user_version', { simple: true }) as number;
    for (const { version, file } of migrations) {
      if (version <= current) continue;
      db.exec(fs.readFileSync(file, 'utf8'));
      db.pragma(`user_version = ${version}`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
