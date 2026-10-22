import Link from 'next/link';
import type { AdhocRow } from '@core/index';
import { deleteAdhocRun } from '../actions/adhoc';
import { cancelQueued, cancelRun } from '../actions/runs';
import { ActionButton, ActionErrorProvider } from '../components/ActionButton';
import { AdhocForm } from '../components/AdhocForm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Pill, RunPill } from '../components/Pill';
import { getCore } from '../lib/core';

export const dynamic = 'force-dynamic';

function Status({ row }: { row: AdhocRow }) {
  if (row.status === 'queued') return <Pill variant="info">queued #{row.queuePosition ?? '?'}</Pill>;
  if (row.status === 'running') return <Pill variant="running">● running</Pill>;
  return <RunPill run={row} />;
}

function RowAction({ row }: { row: AdhocRow }) {
  if (row.status === 'queued') {
    return (
      <ConfirmDialog
        className="btn-link"
        label="cancel"
        message="Remove this ad-hoc Run from the queue?"
        confirmLabel="Remove from queue"
        dismissLabel="Keep queued"
        action={cancelQueued.bind(null, row.id)}
      />
    );
  }
  if (row.status === 'running') {
    return (
      <ConfirmDialog
        className="btn-link"
        label="cancel"
        message="Cancelling can't undo replies or pushes that already happened."
        confirmLabel="Cancel run"
        dismissLabel="Keep running"
        danger
        action={cancelRun.bind(null, row.id)}
      />
    );
  }
  return (
    <ActionButton className="btn-link" action={deleteAdhocRun.bind(null, row.id)}>
      delete
    </ActionButton>
  );
}

function History({ rows }: { rows: AdhocRow[] }) {
  if (rows.length === 0) return <EmptyState>No ad-hoc Runs yet.</EmptyState>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>#</th>
          <th>Prompt</th>
          <th>Repository</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <Link href={`/runs/${row.id}`}>{row.id}</Link>
            </td>
            <td className="cell-text" title={row.prompt}>
              {row.prompt}
            </td>
            <td>{row.repository}</td>
            <td className="nowrap">
              <Status row={row} />
            </td>
            <td className="nowrap">
              <div className="row-actions">
                <Link href={`/runs/${row.id}`}>open</Link> · <RowAction row={row} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AdhocPage() {
  const core = getCore();
  const { repositories, models, defaultModel } = core.read.formOptions();
  const { rows } = core.read.adhocView();
  return (
    <ActionErrorProvider>
      <h1 className="page-title">New ad-hoc run</h1>
      <AdhocForm options={{ repositories, models, defaultModel }} />
      <h2 className="section-h">Ad-hoc history</h2>
      <History rows={rows} />
    </ActionErrorProvider>
  );
}
