import type { RunStatus, ThreadView } from '@core/index';

// Details of a Run auto-refresh until the Run and every Run in its Chat thread have finished.
export function keepsRefreshing(status: RunStatus, thread: ThreadView | null): boolean {
  return status !== 'finished' || (thread?.runs.some((r) => r.status !== 'finished') ?? false);
}
