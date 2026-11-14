'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatDateTime } from '../lib/format';

// Shows that the latest check of an Automation was skipped, with when it was supposed to run.
export function SkippedCheck({ at }: { at: number }) {
  const t = useTranslations('SkippedCheck');
  const locale = useLocale();
  return (
    <span className="muted" data-testid="skipped-check" title={t('title', { at: formatDateTime(at, locale) })}>
      {t('label')} · {formatDateTime(at, locale)}
    </span>
  );
}
