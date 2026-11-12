import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { NeedsYouCard, QueueRow, RunningCard } from '@core/index';
import { cancelRun } from './actions/runs';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Elapsed } from './components/Elapsed';
import { EmptyState } from './components/EmptyState';
import { Pill } from './components/Pill';
import { RelativeTime } from './components/RelativeTime';
import { RunItem } from './components/RunMeta';
import { getCore } from './lib/core';
import { currentScope } from './lib/scope';

export const dynamic = 'force-dynamic';

function NeedsYou({ cards }: { cards: NeedsYouCard[] }) {
  const t = useTranslations('Home');
  return (
    <section aria-label={t('needsYou')} className="home-section">
      <div className="section-heading">
        <h2>{t('needsYou')}</h2>
        {cards.length > 0 && <span className="attention-count">{cards.length}</span>}
      </div>
      {cards.length === 0 && <EmptyState>{t('nothingNeedsYou')}</EmptyState>}
      {cards.map((card) => (
        <article key={card.watchId} className="card card-needs attention-card">
          <div>
            <div className="attention-since muted">
              {t('decisionNeeded')}
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
                  · <Link href={`/runs/${card.runId}`}>{t('run', { id: card.runId })}</Link>
                </>
              )}
            </div>
            {card.reason !== null && <p className="attention-reason">{card.reason}</p>}
          </div>
          <Link href={`/watches/${card.watchId}`} className="btn btn-primary">
            {t('reviewDecision')}
          </Link>
        </article>
      ))}
    </section>
  );
}

function NowRunning({ runs }: { runs: RunningCard[] }) {
  const t = useTranslations('Home');
  const tt = useTranslations('Trigger');
  return (
    <section aria-labelledby="now-running" className="card operating-card">
      <div className="section-heading">
        <h2 id="now-running">{t('runningNow')}</h2>
      </div>
      {runs.length === 0 && <EmptyState>{t('nothingRunning')}</EmptyState>}
      {runs.map((run) => (
        <div key={run.runId}>
          <Pill variant="running">
            <Elapsed since={run.startedAt} />
          </Pill>
          <Link href={`/runs/${run.runId}`} className="task-title">
            <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />{' '}
          </Link>
          <p className="task-meta">
            {run.repository} · {tt(run.trigger)} · {t('run', { id: run.runId })}
          </p>
          <div className="actions">
            <Link href={`/runs/${run.runId}`} className="btn btn-secondary">
              {t('viewRun')}
            </Link>
            <ConfirmDialog
              label={run.cancelRequested ? t('cancelling') : t('cancel')}
              message={t('cancelMessage')}
              confirmLabel={t('cancelRun')}
              dismissLabel={t('keepRunning')}
              danger
              disabledReason={run.cancelRequested ? t('cancelRequested') : undefined}
              action={cancelRun.bind(null, run.runId)}
            />
          </div>
        </div>
      ))}
    </section>
  );
}

function UpNext({ waiting }: { waiting: QueueRow[] }) {
  const t = useTranslations('Home');
  const tt = useTranslations('Trigger');
  return (
    <section aria-label={t('upNext')} className="card operating-card">
      <div className="section-heading">
        <h2 id="up-next">
          {t('upNext')} {waiting.length > 0 && <span className="muted">{waiting.length}</span>}
        </h2>
        <Link href="/queue" className="section-link">
          {t('openQueue')}
        </Link>
      </div>
      {waiting.length === 0 && <EmptyState>{t('nothingWaiting')}</EmptyState>}
      {waiting.slice(0, 3).map((run) => (
        <div key={run.runId} className="queue-preview-row">
          <div>
            <Link href={`/runs/${run.runId}`} className="plain-link">
              <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
            </Link>
            <p className="task-meta">
              {run.repository} · {tt(run.trigger)}
            </p>
          </div>
          <span className="muted">#{run.position}</span>
        </div>
      ))}
    </section>
  );
}

export default async function HomePage() {
  const t = await getTranslations('Home');
  const core = getCore();
  const scope = await currentScope();
  const { needsYou, running } = core.read.homeView(scope);
  const { waiting } = core.read.queueView(scope);
  return (
    <div className="home-view">
      <div className="page-heading">
        <h1 className="page-title">{t('title')}</h1>
        <p className="muted">
          {needsYou.length === 0 ? t('nothingAttention') : t('itemsAttention', { count: needsYou.length })}
        </p>
      </div>
      <NeedsYou cards={needsYou} />
      <div className="operating-grid">
        <NowRunning runs={running} />
        <UpNext waiting={waiting} />
      </div>
    </div>
  );
}
