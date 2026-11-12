import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
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

const OUTCOME_CHIPS: { outcome: Outcome | undefined; label: 'all' | 'needsYou' | 'errors' | 'acted' | 'nothing' }[] = [
  { outcome: undefined, label: 'all' },
  { outcome: 'needs-you', label: 'needsYou' },
  { outcome: 'error', label: 'errors' },
  { outcome: 'acted', label: 'acted' },
  { outcome: 'nothing', label: 'nothing' },
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
  const t = useTranslations('Runs');
  return (
    <>
      <nav className="history-tabs" aria-label={t('outcomeNav')}>
        {OUTCOME_CHIPS.map(({ outcome, label }) => {
          const on = filter.outcome === outcome;
          return (
            <Link key={label} href={hrefFor({ ...filter, outcome })} aria-current={on ? 'page' : undefined}>
              {t(label)}
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
          aria-label={t('search')}
          placeholder={t('placeholder')}
        />
        <select name="repo" defaultValue={filter.repo ?? ''} aria-label={t('repository')}>
          <option value="">{t('repoAny')}</option>
          {repositories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label>
          {t('from')} <input type="date" name="from" defaultValue={filter.from ?? ''} aria-label={t('fromDate')} />
        </label>
        <label>
          {t('to')} <input type="date" name="to" defaultValue={filter.to ?? ''} aria-label={t('toDate')} />
        </label>
        <button type="submit" className="btn btn-secondary">
          {t('filter')}
        </button>
      </form>
    </>
  );
}

function Took({ run }: { run: RunRow }) {
  const locale = useLocale();
  if (run.status === 'running' && run.startedAt !== null) return <Elapsed since={run.startedAt} />;
  return <>{run.tookMs === null ? '—' : formatTook(run.tookMs, locale)}</>;
}

function RunListRow({ run }: { run: RunRow }) {
  const t = useTranslations('Runs');
  const locale = useLocale();
  const href = `/runs/${run.id}`;
  return (
    <tr>
      <td className="history-task">
        <Link href={href} className="task-title">
          <RunItem watchTitle={run.watchTitle} adhocPrompt={run.adhocPrompt} ticket={run.ticket} />
        </Link>
        <div className="recent-result">{run.summary ?? run.error?.message ?? t('noSummary')}</div>
        <div className="task-meta">
          <Link href={href}>#{run.id}</Link>
        </div>
      </td>
      <td data-label={t('repository')}>{run.repository}</td>
      <td data-label={t('outcome')}>
        <RunPill run={run} />
      </td>
      <td className="history-number" data-label={run.startedAt === null ? t('queued') : t('started')}>
        {formatDateTime(run.startedAt ?? run.queuedAt, locale)}
        {run.startedAt === null && <div className="task-meta">{t('queuedNever')}</div>}
      </td>
      <td className="history-number" data-label={t('duration')}>
        <Took run={run} />
      </td>
    </tr>
  );
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const t = await getTranslations('Runs');
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
        <h1 className="page-title">{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
      </div>
      <RunFilters filter={filter} repositories={repositories} />
      {!dates.ok ? (
        <ErrorBox error={dates.error} />
      ) : (
        <>
          <p className="history-count">{t('count', { count: runs.length })}</p>
          {runs.length === 0 ? (
            <EmptyState>{filtered ? t('noMatch') : t('none')}</EmptyState>
          ) : (
            <table className="table run-history">
              <thead>
                <tr>
                  <th>{t('task')}</th>
                  <th>{t('repository')}</th>
                  <th>{t('outcome')}</th>
                  <th className="history-number">{t('startedQueued')}</th>
                  <th className="history-number">{t('duration')}</th>
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
      <p className="history-help muted">{t('help')}</p>
    </div>
  );
}
