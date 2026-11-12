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

export function formatRelative(at: number, now: number, locale: string): string {
  const diff = now - at;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: locale === 'ru' ? 'short' : 'narrow' });
  if (diff < MINUTE) return rtf.format(0, 'second');
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour');
  return rtf.format(-Math.floor(diff / DAY), 'day');
}

export function formatTook(ms: number, locale: string): string {
  const unit = (value: number, name: 'second' | 'minute' | 'hour') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
  if (ms < MINUTE) return unit(Math.round(ms / SECOND), 'second');
  if (ms < HOUR) return unit(Math.floor(ms / MINUTE), 'minute');
  return `${unit(Math.floor(ms / HOUR), 'hour')} ${unit(Math.floor((ms % HOUR) / MINUTE), 'minute')}`;
}

// Local time of the dashboard host (the server and the browser are the same machine).
export function formatDateTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

export function formatFullDateTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

// Client-safe twin of core's formatDuration (client components can't import @core/index values); a test keeps them equal.
export function formatInterval(ms: number): string {
  for (const [unit, size] of [
    ['d', DAY],
    ['h', HOUR],
    ['m', MINUTE],
  ] as const) {
    if (ms !== 0 && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / SECOND)}s`;
}
