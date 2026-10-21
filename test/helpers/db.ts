import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../../src/core/db/migrate';
import { openDb, type Database } from '../../src/core/db/open';

const tempRoot = path.resolve('test-results', 'tmp');

export function tempDb(): { db: Database; file: string; cleanup(): void } {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'db-'));
  const file = path.join(dir, 'automator.db');
  const db = openDb(file);
  migrate(db);
  return {
    db,
    file,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
