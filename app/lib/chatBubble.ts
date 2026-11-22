import type { ThreadRun } from '@core/index';

// Text shown in a Run's bubble. Plain text only; the file itself is never changed.
// The Copilot share export is passed through unchanged: the PR 1 spike could not confirm that it starts with
// the prompt, so there is no section to drop. If it does, add a Copilot-specific rule here (this would need
// the Run's provider passed in) that drops the leading prompt section at render time.
export function bubbleTranscript(run: Pick<ThreadRun, 'transcript'>): string | null {
  return run.transcript?.text ?? null;
}
