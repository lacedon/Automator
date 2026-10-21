import type { RunStatus, WatchState } from './types';

export type AppError =
  | { code: 'UNKNOWN_REPOSITORY'; name: string; known: string[]; attemptFile: string | null; attemptFileError?: string }
  | { code: 'DUPLICATE_WATCH'; existing: { id: number; state: WatchState; intervalMs: number } }
  | { code: 'INVALID_TARGET'; message: string }
  | { code: 'MISSING_INSTRUCTIONS' }
  | { code: 'INVALID_STATE'; state: WatchState | RunStatus; action: string }
  | { code: 'RUN_IN_PROGRESS'; runId: number }
  | { code: 'JIRA_DISABLED' }
  | { code: 'NOT_FOUND' };

export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
