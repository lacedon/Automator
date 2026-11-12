import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { WatchKind, WatchListView, WatchState } from '@core/index';

export type WatchFilterParams = { state?: WatchState; kind?: WatchKind; repo?: string; q?: string };

const STATE_CHIPS: { state: WatchState | undefined; count: keyof WatchListView['counts'] }[] = [
  { state: undefined, count: 'all' },
  { state: 'needs_you', count: 'needs_you' },
  { state: 'active', count: 'active' },
  { state: 'paused', count: 'paused' },
  { state: 'closed', count: 'closed' },
];

const KINDS: readonly WatchKind[] = ['mr', 'jira', 'free'];

function hrefFor(filter: WatchFilterParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/automations?${query}` : '/automations';
}

type Props = { filter: WatchFilterParams; counts: WatchListView['counts']; repositories: string[] };

export function WatchFilters({ filter, counts, repositories }: Props) {
  const t = useTranslations('WatchFilters');
  const tState = useTranslations('Pill');
  const tKind = useTranslations('KindShort');
  return (
    <div className="filters">
      {STATE_CHIPS.map(({ state, count }) => {
        const on = filter.state === state;
        return (
          <Link
            key={count}
            href={hrefFor({ ...filter, state })}
            className={on ? 'chip on' : 'chip'}
            aria-current={on ? 'page' : undefined}
          >
            {state === undefined ? t('all') : tState(`state_${state}`)} {counts[count]}
          </Link>
        );
      })}
      <span className="spacer" />
      <form method="get" action="/automations" className="filter-form">
        {filter.state && <input type="hidden" name="state" value={filter.state} />}
        <select name="kind" defaultValue={filter.kind ?? ''} aria-label={t('kind')}>
          <option value="">{t('kindAny')}</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {tKind(kind)}
            </option>
          ))}
        </select>
        <select name="repo" defaultValue={filter.repo ?? ''} aria-label={t('repository')}>
          <option value="">{t('repositoryAny')}</option>
          {repositories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          type="search"
          name="q"
          defaultValue={filter.q ?? ''}
          placeholder={t('searchPlaceholder')}
          aria-label={t('search')}
        />
        <button type="submit" className="btn btn-secondary">
          {t('filter')}
        </button>
      </form>
    </div>
  );
}
