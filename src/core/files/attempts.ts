import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config/schema';
import type { AppError } from '../domain/result';
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

// Unknown Repository: records an attempt-scoped error result and returns the error to report, or null when known.
export function unknownRepositoryError(config: Config, dir: DataDir, name: string, now: number): AppError | null {
  if (Object.hasOwn(config.repositories, name)) return null;
  const known = Object.keys(config.repositories).sort();
  const attempt = writeAttemptError(dir, { code: 'UNKNOWN_REPOSITORY', name, known }, now);
  return {
    code: 'UNKNOWN_REPOSITORY',
    name,
    known,
    attemptFile: attempt.path,
    ...(attempt.writeError === undefined ? {} : { attemptFileError: attempt.writeError }),
  };
}
