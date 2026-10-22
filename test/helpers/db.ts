import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../../src/core/db/migrate';
import { openDb, type Database } from '../../src/core/db/open';
import type { Watch } from '../../src/core/domain/types';

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

let watchSeq = 0;

export function insertWatch(
  db: Database,
  partial: Partial<Pick<Watch, 'kind' | 'state' | 'repository' | 'normalizedTarget' | 'targetUrl' | 'title'>> = {},
): number {
  watchSeq += 1;
  const now = Date.parse('2026-10-21T10:00:00');
  const info = db
    .prepare(
      `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      partial.kind ?? 'mr',
      partial.targetUrl ?? `https://gitlab.example.com/g/p/-/merge_requests/${watchSeq}`,
      partial.normalizedTarget ?? `gitlab:gitlab.example.com/g/p!${watchSeq}`,
      partial.repository ?? 'pages',
      partial.title ?? `Watch ${watchSeq}`,
      partial.state ?? 'active',
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}
