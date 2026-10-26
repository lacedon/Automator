import Link from 'next/link';
import type { QueueRow, RunningCard } from '@core/index';
import { cancelQueued, cancelRun, closeWatchFromQueue } from '../actions/runs';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Elapsed } from '../components/Elapsed';
import { EmptyState } from '../components/EmptyState';
import { Pill, PriorityPill, PRIORITY_LABEL } from '../components/Pill';
import { RunItem } from '../components/RunMeta';
import { getCore } from '../lib/core';
import { formatDateTime } from '../lib/format';

export const dynamic = 'force-dynamic';

type Item = Pick<QueueRow, 'runId' | 'watchId' | 'watchTitle' | 'adhocPrompt' | 'ticket'>;

function QueueItem({ run, strong }: { run: Item; strong?: boolean }) {
  const href = run.watchId === null ? `/runs/${run.runId}` : `/watches/${run.watchId}`;
  return (
    <Link href={href} className={strong ? 'plain-link strong' : 'plain-link'}>
      <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
    </Link>
  );
}

function Running({ run }: { run: RunningCard | null }) {
  if (run === null) return <EmptyState>Nothing running.</EmptyState>;
  return (
    <div className="card card-running">
      <div className="card-head">
        <Pill variant="running">
          ● Running <Elapsed since={run.startedAt} limitMs={run.timeoutMs} />
        </Pill>
        <span className="row-text">
          <QueueItem run={run} strong /> · {run.repository}{' '}
          <span className="muted">
            · {PRIORITY_LABEL[run.trigger]} · <Link href={`/runs/${run.runId}`}>run #{run.runId}</Link> · started{' '}
            {formatDateTime(run.startedAt)}
          </span>
        </span>
        <ConfirmDialog
          label={run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
          message="Cancelling can't undo replies or pushes that already happened."
          confirmLabel="Cancel run"
          dismissLabel="Keep running"
          danger
          disabledReason={run.cancelRequested ? 'Cancel already requested' : undefined}
          action={cancelRun.bind(null, run.runId)}
        />
      </div>
      <div className="muted">Live transcript isn&apos;t available in v1. It appears when the Run finishes.</div>
    </div>
  );
}

function WaitingAction({ row }: { row: QueueRow }) {
  if (row.watchId !== null) {
    return (
      <ConfirmDialog
        className="btn-link"
        label="close Watch"
        message="Closing stops follow-up and removes its queued request. History is kept until cleanup."
        confirmLabel="Close Watch"
        dismissLabel="Keep watching"
        action={closeWatchFromQueue.bind(null, row.watchId)}
      />
    );
  }
  return (
    <ConfirmDialog
      className="btn-link"
      label="cancel"
      message="Remove this ad-hoc Run from the queue?"
      confirmLabel="Remove from queue"
      dismissLabel="Keep queued"
      action={cancelQueued.bind(null, row.runId)}
    />
  );
}

function Waiting({ rows }: { rows: QueueRow[] }) {
  if (rows.length === 0) return <EmptyState>Nothing waiting.</EmptyState>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>#</th>
          <th>Priority</th>
          <th>Item</th>
          <th>Repository</th>
          <th>Queued</th>
          <th>Reason</th>
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
            <td className="nowrap">{formatDateTime(row.queuedAt)}</td>
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

export default function QueuePage() {
  const { running, waiting } = getCore().read.queueView();
  return (
    <>
      <h2 className="section-h">Running</h2>
      <Running run={running} />
      <h2 className="section-h">Waiting · manual &amp; ad-hoc go first</h2>
      <Waiting rows={waiting} />
    </>
  );
}
