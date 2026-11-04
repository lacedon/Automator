import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppError } from '../domain/result';
import type { RepositoryService } from '../repositories/repositoryService';
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
export function repositoryError(
  repositories: RepositoryService,
  dir: DataDir,
  name: string,
  now: number,
): AppError | null {
  const repository = repositories.get(name);
  if (repository !== null) {
    const issues = repositories.status(repository.name);
    return issues.length === 0
      ? null
      : {
          code: 'INVALID_INPUT',
          field: 'repository',
          message: `Repository "${repository.name}" is invalid: ${issues.join('; ')}`,
        };
  }
  const known = repositories
    .list()
    .map((repository) => repository.name)
    .sort();
  const attempt = writeAttemptError(dir, { code: 'UNKNOWN_REPOSITORY', name, known }, now);
  return {
    code: 'UNKNOWN_REPOSITORY',
    name,
    known,
    attemptFile: attempt.path,
    ...(attempt.writeError === undefined ? {} : { attemptFileError: attempt.writeError }),
  };
}
