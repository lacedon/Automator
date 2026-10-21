import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './atomic';
import type { DataDir } from './dataDir';

export function writeAttemptError(
  dir: DataDir,
  error: { code: string; [k: string]: unknown },
  now: number,
): { path: string | null; writeError?: string } {
  const attemptId = randomUUID();
  const at = new Date(now).toISOString();
  const file = path.join(dir.attemptsDir, `${at.replaceAll(':', '-')}-${attemptId}.json`);
  try {
    writeJsonAtomic(file, { schemaVersion: 1, attemptId, at, status: 'error', error });
    return { path: file };
  } catch (e) {
    return { path: null, writeError: e instanceof Error ? e.message : String(e) };
  }
}
