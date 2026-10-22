'use client';

import { formatRelative } from '../lib/format';
import { useNow } from './useNow';

export function RelativeTime({ at }: { at: number }) {
  const now = useNow(15_000);
  return (
    <time
      className="muted"
      dateTime={new Date(at).toISOString()}
      title={now === null ? undefined : new Date(at).toLocaleString()}
    >
      {now === null ? '' : formatRelative(at, now)}
    </time>
  );
}
