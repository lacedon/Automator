import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { formatDuration, type WatchKind, type WatchRow, type WatchState } from '@core/index';
import { ActionErrorProvider } from '../components/ActionButton';
import { EmptyState } from '../components/EmptyState';
import { NextCheckLabel, RunPill, WatchStatePill } from '../components/Pill';
import { RelativeTime } from '../components/RelativeTime';
import { WatchFilters, type WatchFilterParams } from '../components/WatchFilters';
import { ResumeButton, WatchRowMenu } from '../components/WatchRowMenu';
import { getCore } from '../lib/core';
import { currentScope } from '../lib/scope';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const STATES: readonly WatchState[] = ['needs_you', 'active', 'paused', 'closed'];
const KINDS: readonly WatchKind[] = ['mr', 'jira', 'free'];

function pick<T extends string>(value: string | string[] | undefined, allowed?: readonly T[]): T | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  return allowed === undefined || allowed.includes(v as T) ? (v as T) : undefined;
}

function WatchTableRow({ row, jiraEnabled, kindLabel }: { row: WatchRow; jiraEnabled: boolean; kindLabel: string }) {
  const needsYou = row.state === 'needs_you';
  const closed = row.state === 'closed';
  return (
    <tr className={needsYou ? 'needs-row' : undefined}>
      <td>
        <WatchStatePill state={row.state} />
      </td>
      <td>{kindLabel}</td>
      <td className="cell-text">
        <Link
          href={`/automations/${row.id}`}
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
  const t = await getTranslations('AutomationList');
  const tKind = await getTranslations('KindShort');
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
    project: await currentScope(),
  });
  const { repositories, jiraEnabled, byRepository } = core.read.formOptions(await currentScope());
  const filtered =
    filter.state !== undefined || filter.kind !== undefined || filter.repo !== undefined || filter.q !== undefined;

  return (
    <ActionErrorProvider>
      <WatchFilters filter={filter} counts={counts} repositories={repositories.map((r) => r.name)} />
      {jiraNotice && <div className="notice">{t.rich('jiraNotice', { code: (chunks) => <code>{chunks}</code> })}</div>}
      {rows.length === 0 ? (
        <EmptyState>{filtered ? t('noMatch') : t('none')}</EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('state')}</th>
              <th>{t('kind')}</th>
              <th>{t('target')}</th>
              <th>{t('repository')}</th>
              <th>{t('every')}</th>
              <th>{t('nextCheck')}</th>
              <th>{t('lastRun')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <WatchTableRow
                key={row.id}
                row={row}
                kindLabel={tKind(row.kind)}
                jiraEnabled={byRepository[row.repository]?.jiraEnabled ?? jiraEnabled}
              />
            ))}
          </tbody>
        </table>
      )}
    </ActionErrorProvider>
  );
}
