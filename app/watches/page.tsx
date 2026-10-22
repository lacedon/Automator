import Link from 'next/link';
import { formatDuration, type WatchKind, type WatchRow, type WatchState } from '@core/index';
import { ActionErrorProvider } from '../components/ActionButton';
import { EmptyState } from '../components/EmptyState';
import { NextCheckLabel, RunPill, WatchStatePill } from '../components/Pill';
import { RelativeTime } from '../components/RelativeTime';
import { KIND_LABEL, WatchFilters, type WatchFilterParams } from '../components/WatchFilters';
import { ResumeButton, WatchRowMenu } from '../components/WatchRowMenu';
import { getCore } from '../lib/core';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const STATES: readonly WatchState[] = ['needs_you', 'active', 'paused', 'closed'];
const KINDS: readonly WatchKind[] = ['mr', 'jira', 'free'];

function pick<T extends string>(value: string | string[] | undefined, allowed?: readonly T[]): T | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  return allowed === undefined || allowed.includes(v as T) ? (v as T) : undefined;
}

function WatchTableRow({ row, jiraEnabled }: { row: WatchRow; jiraEnabled: boolean }) {
  const needsYou = row.state === 'needs_you';
  const closed = row.state === 'closed';
  return (
    <tr className={needsYou ? 'needs-row' : undefined}>
      <td>
        <WatchStatePill state={row.state} />
      </td>
      <td>{KIND_LABEL[row.kind]}</td>
      <td className="cell-text">
        <Link
          href={`/watches/${row.id}`}
          className={needsYou ? 'plain-link strong' : closed ? 'plain-link muted' : 'plain-link'}
          title={row.targetUrl}
        >
          {row.title}
        </Link>
      </td>
      <td className={closed ? 'muted' : undefined}>{row.repository}</td>
      <td className={closed ? 'muted' : undefined}>{closed ? '—' : formatDuration(row.everyMs)}</td>
      <td className="nowrap">
        <NextCheckLabel next={row.nextCheck} />
      </td>
      <td className="nowrap">
        {row.lastRun === null ? (
          <span className="muted">—</span>
        ) : (
          <>
            <RunPill run={{ ...row.lastRun, status: 'finished' }} />{' '}
            {row.lastRun.endedAt !== null && <RelativeTime at={row.lastRun.endedAt} />}
          </>
        )}
      </td>
      <td className="row-actions">
        {needsYou && <ResumeButton watchId={row.id} />}
        <WatchRowMenu
          watch={{ id: row.id, kind: row.kind, state: row.state, running: row.running }}
          actions={row.actions}
          jiraEnabled={jiraEnabled}
        />
      </td>
    </tr>
  );
}

export default async function WatchesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter: WatchFilterParams = {
    state: pick(params.state, STATES),
    kind: pick(params.kind, KINDS),
    repo: pick(params.repo),
    q: pick(params.q),
  };
  const core = getCore();
  const { counts, jiraNotice, rows } = core.read.watchList({
    state: filter.state,
    kind: filter.kind,
    repository: filter.repo,
    q: filter.q,
  });
  const { repositories, jiraEnabled } = core.read.formOptions();
  const filtered =
    filter.state !== undefined || filter.kind !== undefined || filter.repo !== undefined || filter.q !== undefined;

  return (
    <ActionErrorProvider>
      <WatchFilters filter={filter} counts={counts} repositories={repositories.map((r) => r.name)} />
      {jiraNotice && (
        <div className="notice">
          Jira checking is off (<code>jira.enabled</code> is false). Jira Watches are kept but don&apos;t run on
          schedule or via Run now.
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState>{filtered ? 'No Watches match these filters.' : 'No Watches yet.'}</EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>State</th>
              <th>Kind</th>
              <th>Target</th>
              <th>Repository</th>
              <th>Every</th>
              <th>Next check</th>
              <th>Last run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <WatchTableRow key={row.id} row={row} jiraEnabled={jiraEnabled} />
            ))}
          </tbody>
        </table>
      )}
    </ActionErrorProvider>
  );
}
