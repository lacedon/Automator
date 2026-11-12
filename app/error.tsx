'use client';

import { useTranslations } from 'next-intl';

// Shown when a page or Server Action throws unexpectedly (for example SQLITE_BUSY); details are in the server log.
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations('Error');
  return (
    <div className="error-box" role="alert">
      <div className="error-title">{t('title')}</div>
      <p>{error.message || t('unexpected')}</p>
      {error.digest !== undefined && <p className="muted">{t('digest', { digest: error.digest })}</p>}
      <p>
        <button type="button" className="btn btn-secondary" onClick={() => retry()}>
          {t('retry')}
        </button>
      </p>
    </div>
  );
}
