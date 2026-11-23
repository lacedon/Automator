import type { Outcome, ResultStatus, WatchKind, WatchState } from '../domain/types';

export const TELEGRAM_LIMIT = 4096;
const RESULT_CAP = 6000;

// Splits at line breaks where possible so no message exceeds Telegram's limit.
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest !== '' || parts.length === 0) parts.push(rest);
  return parts;
}

export function truncate(text: string, max = RESULT_CAP): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}…`, truncated: true };
}

const STATE_LABEL: Record<WatchState, string> = {
  needs_you: '🔴 Needs you',
  active: '🟢 Active',
  paused: '⏸ Paused',
  closed: '⚫ Closed',
};
const KIND_LABEL: Record<WatchKind, string> = { mr: 'MR', jira: 'Jira', free: 'Free' };

export const stateLabel = (state: WatchState) => STATE_LABEL[state];
export const kindLabel = (kind: WatchKind) => KIND_LABEL[kind];

export function runStatusLabel(run: {
  status: string;
  outcome: Outcome | null;
  resultStatus: ResultStatus | null;
  interrupted: string | null;
}): string {
  if (run.status !== 'finished') return run.status;
  if (run.interrupted !== null) return `interrupted (${run.interrupted})`;
  if (run.resultStatus === 'error') return 'failed';
  return run.outcome === 'done' ? 'replied' : (run.outcome ?? 'finished');
}

export function timeAgo(ms: number | null, now: number): string {
  if (ms === null) return '-';
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export const oneLine = (text: string | null, max = 60): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
