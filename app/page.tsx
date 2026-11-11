import Link from 'next/link';
import type { NeedsYouCard, QueueRow, RunningCard } from '@core/index';
import { cancelRun } from './actions/runs';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Elapsed } from './components/Elapsed';
import { EmptyState } from './components/EmptyState';
import { Pill } from './components/Pill';
import { RelativeTime } from './components/RelativeTime';
import { RunItem, TRIGGER_NAME } from './components/RunMeta';
import { getCore } from './lib/core';
import { currentScope } from './lib/scope';

export const dynamic = 'force-dynamic';

function NeedsYou({ cards }: { cards: NeedsYouCard[] }) {
  return (
    <section aria-label="Needs you" className="home-section">
      <div className="section-heading">
        <h2>Needs you</h2>
        {cards.length > 0 && <span className="attention-count">{cards.length}</span>}
      </div>
      {cards.length === 0 && <EmptyState>Nothing needs you.</EmptyState>}
      {cards.map((card) => (
        <article key={card.watchId} className="card card-needs attention-card">
          <div>
            <div className="attention-since muted">
              Decision needed
              {card.since !== null && (
                <>
                  {' '}
                  · <RelativeTime at={card.since} />
                </>
              )}
            </div>
            <Link href={`/automations/${card.watchId}`} className="card-title">
              {card.title}
            </Link>
            <div className="task-meta">
              {card.repository}
              {card.runId !== null && (
                <>
                  {' '}
                  · <Link href={`/runs/${card.runId}`}>Run #{card.runId}</Link>
                </>
              )}
            </div>
            {card.reason !== null && <p className="attention-reason">{card.reason}</p>}
          </div>
          <Link href={`/watches/${card.watchId}`} className="btn btn-primary">
            Review decision
          </Link>
        </article>
      ))}
    </section>
  );
}

function NowRunning({ run }: { run: RunningCard | null }) {
  return (
    <section aria-labelledby="now-running" className="card operating-card">
      <div className="section-heading">
        <h2 id="now-running">Running now</h2>
        {run !== null && (
          <Pill variant="running">
            <Elapsed since={run.startedAt} />
          </Pill>
        )}
      </div>
      {run === null ? (
        <EmptyState>Nothing running.</EmptyState>
      ) : (
        <>
          <Link href={`/runs/${run.runId}`} className="task-title">
            <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />{' '}
          </Link>
          <p className="task-meta">
            {run.repository} · {TRIGGER_NAME[run.trigger]} · Run #{run.runId}
          </p>
          <div className="actions">
            <Link href={`/runs/${run.runId}`} className="btn btn-secondary">
              View run
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
        </>
      )}
    </section>
  );
}

function UpNext({ waiting }: { waiting: QueueRow[] }) {
  return (
    <section aria-label="Up next" className="card operating-card">
      <div className="section-heading">
        <h2 id="up-next">Up next {waiting.length > 0 && <span className="muted">{waiting.length}</span>}</h2>
        <Link href="/queue" className="section-link">
          Open queue
        </Link>
      </div>
      {waiting.length === 0 && <EmptyState>Nothing waiting.</EmptyState>}
      {waiting.slice(0, 3).map((run) => (
        <div key={run.runId} className="queue-preview-row">
          <div>
            <Link href={`/runs/${run.runId}`} className="plain-link">
              <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
            </Link>
            <p className="task-meta">
              {run.repository} · {TRIGGER_NAME[run.trigger]}
            </p>
          </div>
          <span className="muted">#{run.position}</span>
        </div>
      ))}
    </section>
  );
}

export default async function HomePage() {
  const core = getCore();
  const scope = await currentScope();
  const { needsYou, running } = core.read.homeView(scope);
  const { waiting } = core.read.queueView(scope);
  return (
    <div className="home-view">
      <div className="page-heading">
        <h1 className="page-title">Home</h1>
        <p className="muted">
          {needsYou.length === 0
            ? 'Nothing needs your attention.'
            : `${needsYou.length} ${needsYou.length === 1 ? 'item needs' : 'items need'} your attention.`}
        </p>
      </div>
      <NeedsYou cards={needsYou} />
      <div className="operating-grid">
        <NowRunning run={running} />
        <UpNext waiting={waiting} />
      </div>
    </div>
  );
}
