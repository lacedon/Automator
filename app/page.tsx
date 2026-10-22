import Link from 'next/link';
import type { NeedsYouCard, RunningCard, RunRow } from '@core/index';
import { cancelRun } from './actions/runs';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Elapsed } from './components/Elapsed';
import { EmptyState } from './components/EmptyState';
import { Pill, RunPill } from './components/Pill';
import { RelativeTime } from './components/RelativeTime';
import { ResumeForm } from './components/ResumeForm';
import { getCore } from './lib/core';

export const dynamic = 'force-dynamic';

function RunTitle({ watchTitle, adhocPrompt }: { watchTitle: string | null; adhocPrompt: string | null }) {
  if (watchTitle !== null) return <>{watchTitle}</>;
  return (
    <>
      <em>ad-hoc:</em> {adhocPrompt}
    </>
  );
}

function NeedsYou({ cards }: { cards: NeedsYouCard[] }) {
  return (
    <section aria-labelledby="needs-you">
      <h2 id="needs-you" className="section-h">
        Needs you <Pill variant={cards.length > 0 ? 'needs-you' : 'neutral'}>{cards.length}</Pill>
      </h2>
      {cards.length === 0 && <EmptyState>Nothing needs you.</EmptyState>}
      {cards.map((card) => (
        <div key={card.watchId} className="card card-needs">
          <div>
            <Link href={`/watches/${card.watchId}`} className="card-title">
              {card.title}
            </Link>{' '}
            <span className="muted">· {card.repository}</span>
            {card.since !== null && (
              <span className="card-since">
                <RelativeTime at={card.since} />
              </span>
            )}
          </div>
          {card.reason !== null && <div className="muted">{card.reason}</div>}
          {card.runId !== null && (
            <div className="muted">
              From <Link href={`/runs/${card.runId}`}>Run #{card.runId}</Link>
            </div>
          )}
          <ResumeForm watchId={card.watchId} />
        </div>
      ))}
    </section>
  );
}

function NowRunning({ run }: { run: RunningCard }) {
  return (
    <section aria-labelledby="now-running">
      <h2 id="now-running" className="section-h">
        Now running
      </h2>
      <div className="row">
        <Pill variant="running">
          ● <Elapsed since={run.startedAt} />
        </Pill>
        <Link href={`/runs/${run.runId}`} className="row-text">
          <RunTitle watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} />{' '}
          <span className="muted">· {run.repository}</span>
        </Link>
        <ConfirmDialog
          label={run.cancelRequested ? 'Cancelling…' : 'Cancel'}
          message="Cancelling can't undo replies or pushes that already happened."
          confirmLabel="Cancel run"
          dismissLabel="Keep running"
          danger
          disabledReason={run.cancelRequested ? 'Cancel already requested' : undefined}
          action={cancelRun.bind(null, run.runId)}
        />
      </div>
    </section>
  );
}

function RecentRuns({ runs }: { runs: RunRow[] }) {
  return (
    <section aria-labelledby="recent-runs">
      <h2 id="recent-runs" className="section-h">
        Recent Runs
      </h2>
      {runs.length === 0 && <EmptyState>No Runs yet.</EmptyState>}
      {runs.map((run) => (
        <Link key={run.id} href={`/runs/${run.id}`} className="row row-link">
          <RunPill run={run} />
          <span className="row-text">
            <RunTitle watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} />
            {run.summary !== null && <span className="muted"> · {run.summary}</span>}
          </span>
          <RelativeTime at={run.endedAt ?? run.startedAt ?? run.queuedAt} />
        </Link>
      ))}
    </section>
  );
}

export default function HomePage() {
  const { needsYou, running, recent } = getCore().read.homeView();
  return (
    <>
      <NeedsYou cards={needsYou} />
      {running !== null && <NowRunning run={running} />}
      <RecentRuns runs={recent} />
    </>
  );
}
