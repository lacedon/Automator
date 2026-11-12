import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { QueueRow, RunningCard } from '@core/index';
import { cancelQueued, cancelRun, closeWatchFromQueue } from '../actions/runs';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Elapsed } from '../components/Elapsed';
import { EmptyState } from '../components/EmptyState';
import { Pill, PriorityPill } from '../components/Pill';
import { RunItem } from '../components/RunMeta';
import { getCore } from '../lib/core';
import { currentScope } from '../lib/scope';
import { formatDateTime } from '../lib/format';

export const dynamic = 'force-dynamic';

type Item = Pick<QueueRow, 'runId' | 'watchId' | 'watchTitle' | 'adhocPrompt' | 'ticket'>;

function QueueItem({ run, strong }: { run: Item; strong?: boolean }) {
  const href = run.watchId === null ? `/runs/${run.runId}` : `/automations/${run.watchId}`;
  return (
    <Link href={href} className={strong ? 'plain-link strong' : 'plain-link'}>
      <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
    </Link>
  );
}

function Running({ runs }: { runs: RunningCard[] }) {
  const t = useTranslations('Queue');
  if (runs.length === 0) return <EmptyState>{t('nothingRunning')}</EmptyState>;
  return (
    <>
      {runs.map((run) => (
        <RunningRun key={run.runId} run={run} />
      ))}
    </>
  );
}

function RunningRun({ run }: { run: RunningCard }) {
  const t = useTranslations('Queue');
  const locale = useLocale();
  return (
    <div className="card card-running">
      <div className="card-head">
        <Pill variant="running">
          {t('runningPill')} <Elapsed since={run.startedAt} limitMs={run.timeoutMs} />
        </Pill>
        <span className="row-text">
          <QueueItem run={run} strong /> · {run.repository}{' '}
          <span className="muted">
            · {t(`priorityLabel.${run.trigger}`)} ·{' '}
            <Link href={`/runs/${run.runId}`}>{t('run', { id: run.runId })}</Link> ·{' '}
            {t('started', { time: formatDateTime(run.startedAt, locale) })}
          </span>
        </span>
        <ConfirmDialog
          label={run.cancelRequested ? t('cancelling') : t('cancelRun')}
          message={t('cancelMessage')}
          confirmLabel={t('cancelRun')}
          dismissLabel={t('keepRunning')}
          danger
          disabledReason={run.cancelRequested ? t('cancelRequested') : undefined}
          action={cancelRun.bind(null, run.runId)}
        />
      </div>
      <div className="muted">{t('noTranscript')}</div>
    </div>
  );
}

function WaitingAction({ row }: { row: QueueRow }) {
  const t = useTranslations('Queue');
  if (row.watchId !== null) {
    return (
      <ConfirmDialog
        className="btn-link"
        label={t('closeAutomation')}
        message={t('closeMessage')}
        confirmLabel={t('closeConfirm')}
        dismissLabel={t('keepAutomation')}
        action={closeWatchFromQueue.bind(null, row.watchId)}
      />
    );
  }
  return (
    <ConfirmDialog
      className="btn-link"
      label={t('cancel')}
      message={t('removeMessage')}
      confirmLabel={t('remove')}
      dismissLabel={t('keepQueued')}
      action={cancelQueued.bind(null, row.runId)}
    />
  );
}

function Waiting({ rows }: { rows: QueueRow[] }) {
  const t = useTranslations('Queue');
  const locale = useLocale();
  if (rows.length === 0) return <EmptyState>{t('nothingWaiting')}</EmptyState>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>#</th>
          <th>{t('priority')}</th>
          <th>{t('item')}</th>
          <th>{t('repository')}</th>
          <th>{t('queued')}</th>
          <th>{t('reason')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.runId}>
            <td>{row.position}</td>
            <td>
              <PriorityPill trigger={row.trigger} />
            </td>
            <td className="cell-text">
              <QueueItem run={row} />
            </td>
            <td>{row.repository}</td>
            <td className="nowrap">{formatDateTime(row.queuedAt, locale)}</td>
            <td className="cell-text">{row.reason}</td>
            <td className="nowrap">
              <div className="row-actions">
                <WaitingAction row={row} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function QueuePage() {
  const t = await getTranslations('Queue');
  const { running, waiting } = getCore().read.queueView(await currentScope());
  return (
    <>
      <h2 className="section-h">{t('running')}</h2>
      <Running runs={running} />
      <h2 className="section-h">{t('waiting')}</h2>
      <Waiting rows={waiting} />
    </>
  );
}
