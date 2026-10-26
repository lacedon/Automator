import Link from 'next/link';
import type { RunFilter, RunRow, Trigger } from '@core/index';
import { Elapsed } from '../components/Elapsed';
import { EmptyState } from '../components/EmptyState';
import { RunPill } from '../components/Pill';
import { RunItem, TRIGGER_NAME } from '../components/RunMeta';
import { getCore } from '../lib/core';
import { formatDateTime, formatTook } from '../lib/format';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
type Outcome = NonNullable<RunFilter['outcome']>;
type Filter = { outcome?: Outcome; trigger?: Trigger; repo?: string };

const OUTCOME_CHIPS: { outcome: Outcome | undefined; label: string }[] = [
  { outcome: undefined, label: 'All' },
  { outcome: 'needs-you', label: 'needs-you' },
  { outcome: 'acted', label: 'acted' },
  { outcome: 'nothing', label: 'nothing' },
  { outcome: 'error', label: 'errors' },
];
const OUTCOMES: readonly Outcome[] = ['needs-you', 'acted', 'nothing', 'error'];
const TRIGGERS: readonly Trigger[] = ['schedule', 'manual', 'adhoc'];

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
    <div className="filters">
      {OUTCOME_CHIPS.map(({ outcome, label }) => {
        const on = filter.outcome === outcome;
        return (
          <Link
            key={label}
            href={hrefFor({ ...filter, outcome })}
            className={on ? 'chip on' : 'chip'}
            aria-current={on ? 'page' : undefined}
          >
            {label}
          </Link>
        );
      })}
      <span className="spacer" />
      <form method="get" action="/runs" className="filter-form">
        {filter.outcome && <input type="hidden" name="outcome" value={filter.outcome} />}
        <select name="trigger" defaultValue={filter.trigger ?? ''} aria-label="Trigger">
          <option value="">Trigger: any</option>
          {TRIGGERS.map((t) => (
            <option key={t} value={t}>
              {TRIGGER_NAME[t]}
            </option>
          ))}
        </select>
        <select name="repo" defaultValue={filter.repo ?? ''} aria-label="Repository">
          <option value="">Repository: any</option>
          {repositories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-secondary">
          Filter
        </button>
      </form>
    </div>
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
      <td>
        <Link href={href}>{run.id}</Link>
      </td>
      <td className="cell-text">
        <Link href={href} className="plain-link">
          <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
        </Link>
      </td>
      <td>{run.repository}</td>
      <td>{TRIGGER_NAME[run.trigger]}</td>
      <td className="nowrap">{run.startedAt === null ? '—' : formatDateTime(run.startedAt)}</td>
      <td className="nowrap">
        <Took run={run} />
      </td>
      <td>
        <RunPill run={run} />
      </td>
      <td className="cell-text">
        <Link href={href} className="plain-link">
          {run.summary ?? run.error?.message ?? '—'}
        </Link>
      </td>
    </tr>
  );
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter: Filter = {
    outcome: pick(params.outcome, OUTCOMES),
    trigger: pick(params.trigger, TRIGGERS),
    repo: pick(params.repo),
  };
  const core = getCore();
  const runs = core.read.runList({ outcome: filter.outcome, trigger: filter.trigger, repository: filter.repo });
  const repositories = core.read.formOptions().repositories.map((r) => r.name);
  const filtered = filter.outcome !== undefined || filter.trigger !== undefined || filter.repo !== undefined;

  return (
    <>
      <RunFilters filter={filter} repositories={repositories} />
      {runs.length === 0 ? (
        <EmptyState>{filtered ? 'No Runs match these filters.' : 'No Runs yet.'}</EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Watch / prompt</th>
              <th>Repository</th>
              <th>Trigger</th>
              <th>Started</th>
              <th>Took</th>
              <th>Outcome</th>
              <th>Summary</th>
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
  );
}
