import Link from 'next/link';
import type { NeedsYouEvent, Watch } from '@core/index';
import { RelativeTime } from './RelativeTime';
import { ResumeForm } from './ResumeForm';

function TeamsStatus({ event }: { event: NeedsYouEvent }) {
  switch (event.teamsStatus) {
    case 'sent':
      return <>sent ✓</>;
    case 'failed':
      return <span className="danger-text">failed: {event.teamsError ?? 'unknown error'}</span>;
    case 'pending':
      return <>pending</>;
    case 'disabled':
      return <>off</>;
  }
}

export function NeedsYouCard({ watch, event }: { watch: Watch; event: NeedsYouEvent | null }) {
  const reason = watch.needsYouReason ?? event?.reason ?? null;
  const since = watch.needsYouSince ?? event?.createdAt ?? null;
  const runId = watch.needsYouRunId ?? event?.runId ?? null;
  return (
    <div className="card card-needs">
      <div>
        <b>Why it needs you</b>
        {since !== null && (
          <span className="muted">
            {' · since '}
            <RelativeTime at={since} />
          </span>
        )}
        {runId !== null && (
          <span className="muted">
            {' · '}
            <Link href={`/runs/${runId}`}>Run #{runId}</Link>
          </span>
        )}
      </div>
      {reason !== null && <p className="needs-reason">{reason}</p>}
      {event !== null && (
        <div className="muted">
          Teams notification: <TeamsStatus event={event} />
        </div>
      )}
      <ResumeForm watchId={watch.id} withNote />
    </div>
  );
}
