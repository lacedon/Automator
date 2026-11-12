import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { NeedsYouEvent, Watch } from '@core/index';
import { RelativeTime } from './RelativeTime';
import { ResumeForm } from './ResumeForm';

function TeamsStatus({ event }: { event: NeedsYouEvent }) {
  const t = useTranslations('NeedsYouCard');
  switch (event.teamsStatus) {
    case 'sent':
      return <>{t('sent')}</>;
    case 'failed':
      return <span className="danger-text">{t('failed', { error: event.teamsError ?? t('unknownError') })}</span>;
    case 'pending':
      return <>{t('pending')}</>;
    case 'disabled':
      return <>{t('off')}</>;
  }
}

export function NeedsYouCard({ watch, event }: { watch: Watch; event: NeedsYouEvent | null }) {
  const t = useTranslations('NeedsYouCard');
  const reason = watch.needsYouReason ?? event?.reason ?? null;
  const errorResult = reason?.match(/\n\nError result: (\/files\/attempt\/[A-Za-z0-9._-]+)$/) ?? null;
  const since = watch.needsYouSince ?? event?.createdAt ?? null;
  const runId = watch.needsYouRunId ?? event?.runId ?? null;
  return (
    <div className="card card-needs">
      <div>
        <b>{t('why')}</b>
        {since !== null && (
          <span className="muted">
            {t('since')}
            <RelativeTime at={since} />
          </span>
        )}
        {runId !== null && (
          <span className="muted">
            {' · '}
            <Link href={`/runs/${runId}`}>{t('run', { id: runId })}</Link>
          </span>
        )}
      </div>
      {reason !== null && (
        <p className="needs-reason">
          {errorResult === null ? reason : reason.slice(0, errorResult.index)}
          {errorResult !== null && (
            <>
              {' '}
              <Link href={errorResult[1]!}>{t('viewError')}</Link>
            </>
          )}
        </p>
      )}
      {event !== null && (
        <div className="muted">
          {t('teams')} <TeamsStatus event={event} />
        </div>
      )}
      <ResumeForm watchId={watch.id} withNote />
    </div>
  );
}
