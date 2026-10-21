const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatElapsed(ms: number, limitMs?: number): string {
  return limitMs === undefined ? mmss(ms) : `${mmss(ms)} / ${mmss(limitMs)}`;
}

export function formatRelative(at: number, now: number): string {
  const diff = now - at;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  return `${Math.floor(diff / DAY)}d ago`;
}
