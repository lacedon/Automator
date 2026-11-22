import type { ThreadRun } from '@core/index';

// Text shown in a Run's bubble. Plain text only; the file itself is never changed.
// The Copilot share export is passed through unchanged: the PR 1 spike could not confirm that it starts with
// the prompt, so there is no section to drop. If it does, add a Copilot-specific rule here (this would need
// the Run's provider passed in) that drops the leading prompt section at render time.
export function bubbleTranscript(run: Pick<ThreadRun, 'transcript'>): string | null {
  return run.transcript?.text ?? null;
}

// A timer turn's stored prompt is `Scheduled wake-up (set <ISO>):\n\n<message>` (core timerPrompt). The bubble is labelled
// as a wake-up already, so it shows only the message.
const TIMER_HEADER = /^Scheduled wake-up \(set [^)\n]*\):\n\n/;
export function timerRequestText(request: string | null): string | null {
  return request === null ? null : request.replace(TIMER_HEADER, '');
}
