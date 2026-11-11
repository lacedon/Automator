import Link from 'next/link';
import type { RunFilter, RunRow } from '@core/index';
import { Elapsed } from '../components/Elapsed';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { RunPill } from '../components/Pill';
import { RunItem } from '../components/RunMeta';
import { getCore } from '../lib/core';
import { currentScope } from '../lib/scope';
import { formatDateTime, formatTook } from '../lib/format';
import { runDates } from '../lib/runDates';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
type Outcome = NonNullable<RunFilter['outcome']>;
type Filter = { outcome?: Outcome; repo?: string; q?: string; from?: string; to?: string };

const OUTCOME_CHIPS: { outcome: Outcome | undefined; label: string }[] = [
  { outcome: undefined, label: 'All chats' },
  { outcome: 'needs-you', label: 'Needs you' },
  { outcome: 'error', label: 'Errors' },
  { outcome: 'acted', label: 'Acted' },
  { outcome: 'nothing', label: 'No action' },
];
const OUTCOMES: readonly Outcome[] = ['needs-you', 'acted', 'nothing', 'error'];

function pick<T extends string>(value: string | string[] | undefined, allowed?: readonly T[]): T | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  return allowed === undefined || allowed.includes(v as T) ? (v as T) : undefined;
}

function hrefFor(filter: Filter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/runs?${query}` : '/runs';
}

function RunFilters({ filter, repositories }: { filter: Filter; repositories: string[] }) {
  return (
    <>
      <nav className="history-tabs" aria-label="Run outcome">
        {OUTCOME_CHIPS.map(({ outcome, label }) => {
          const on = filter.outcome === outcome;
          return (
            <Link key={label} href={hrefFor({ ...filter, outcome })} aria-current={on ? 'page' : undefined}>
              {label}
            </Link>
          );
        })}
      </nav>
      <form method="get" action="/runs" className="history-filters">
        {filter.outcome && <input type="hidden" name="outcome" value={filter.outcome} />}
        <input
          type="search"
          name="q"
          defaultValue={filter.q ?? ''}
          aria-label="Search runs"
          placeholder="Search task, prompt, result or run ID"
        />
        <select name="repo" defaultValue={filter.repo ?? ''} aria-label="Repository">
          <option value="">Repository: any</option>
          {repositories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label>
          From <input type="date" name="from" defaultValue={filter.from ?? ''} aria-label="From date" />
        </label>
        <label>
          To <input type="date" name="to" defaultValue={filter.to ?? ''} aria-label="To date" />
        </label>
        <button type="submit" className="btn btn-secondary">
          Filter
        </button>
      </form>
    </>
  );
}

function Took({ run }: { run: RunRow }) {
  if (run.status === 'running' && run.startedAt !== null) return <Elapsed since={run.startedAt} />;
  return <>{run.tookMs === null ? '—' : formatTook(run.tookMs)}</>;
}

function RunListRow({ run }: { run: RunRow }) {
  const href = `/runs/${run.id}`;
  return (
    <tr>
      <td className="history-task">
        <Link href={href} className="task-title">
          <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
        </Link>
        <div className="recent-result">{run.summary ?? run.error?.message ?? 'No summary recorded.'}</div>
        <div className="task-meta">
          <Link href={href}>#{run.id}</Link>
        </div>
      </td>
      <td data-label="Repository">{run.repository}</td>
      <td data-label="Outcome">
        <RunPill run={run} />
      </td>
      <td className="history-number" data-label={run.startedAt === null ? 'Queued' : 'Started'}>
        {formatDateTime(run.startedAt ?? run.queuedAt)}
        {run.startedAt === null && <div className="task-meta">Queued · never started</div>}
      </td>
      <td className="history-number" data-label="Duration">
        <Took run={run} />
      </td>
    </tr>
  );
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter: Filter = {
    outcome: pick(params.outcome, OUTCOMES),
    repo: pick(params.repo),
    q: pick(params.q),
    from: pick(params.from),
    to: pick(params.to),
  };
  const core = getCore();
  const dates = runDates(filter.from ?? '', filter.to ?? '');
  const runs = dates.ok
    ? core.read.runList({
        outcome: filter.outcome,
        repository: filter.repo,
        project: await currentScope(),
        q: filter.q,
        startedFrom: dates.startedFrom,
        startedBefore: dates.startedBefore,
      })
    : [];
  const repositories = core.read.formOptions(await currentScope()).repositories.map((r) => r.name);
  const filtered = Object.values(filter).some((value) => value !== undefined);

  return (
    <div className="history-view">
      <div className="page-heading">
        <h1 className="page-title">Chats</h1>
        <p className="muted">
          Ad-hoc chats for the selected project scope. Automation Runs are on each Automation&apos;s page.
        </p>
      </div>
      <RunFilters filter={filter} repositories={repositories} />
      {!dates.ok ? (
        <ErrorBox error={dates.error} />
      ) : (
        <>
          <p className="history-count">
            {runs.length} {runs.length === 1 ? 'Chat' : 'Chats'} · Newest first
          </p>
          {runs.length === 0 ? (
            <EmptyState>{filtered ? 'No chats match these filters.' : 'No chats yet.'}</EmptyState>
          ) : (
            <table className="table run-history">
              <thead>
                <tr>
                  <th>Task / result</th>
                  <th>Repository</th>
                  <th>Outcome</th>
                  <th className="history-number">Started / queued</th>
                  <th className="history-number">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunListRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <p className="history-help muted">
        Outcomes record what happened at the time. A past Needs you Run may already be resolved. Date filters use local
        start time, or queue time if never started.
      </p>
    </div>
  );
}
