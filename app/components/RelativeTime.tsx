'use client';

import { useLocale } from 'next-intl';
import { formatFullDateTime, formatRelative } from '../lib/format';
import { useNow } from './useNow';

export function RelativeTime({ at }: { at: number }) {
  const now = useNow(15_000);
  const locale = useLocale();
  return (
    <time
      className="muted"
      dateTime={new Date(at).toISOString()}
      title={now === null ? undefined : formatFullDateTime(at, locale)}
    >
      {now === null ? '' : formatRelative(at, now, locale)}
    </time>
  );
}
