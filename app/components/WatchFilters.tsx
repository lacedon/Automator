import Link from 'next/link';
import type { WatchKind, WatchListView, WatchState } from '@core/index';

export type WatchFilterParams = { state?: WatchState; kind?: WatchKind; repo?: string; q?: string };

const STATE_CHIPS: { state: WatchState | undefined; label: string; count: keyof WatchListView['counts'] }[] = [
  { state: undefined, label: 'All', count: 'all' },
  { state: 'needs_you', label: 'Needs you', count: 'needs_you' },
  { state: 'active', label: 'Active', count: 'active' },
  { state: 'paused', label: 'Paused', count: 'paused' },
  { state: 'closed', label: 'Closed', count: 'closed' },
];

export const KIND_LABEL: Record<WatchKind, string> = { mr: 'MR', jira: 'Jira', free: 'Free' };

function hrefFor(filter: WatchFilterParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/watches?${query}` : '/watches';
}

type Props = { filter: WatchFilterParams; counts: WatchListView['counts']; repositories: string[] };

export function WatchFilters({ filter, counts, repositories }: Props) {
  return (
    <div className="filters">
      {STATE_CHIPS.map(({ state, label, count }) => {
        const on = filter.state === state;
        return (
          <Link
            key={label}
            href={hrefFor({ ...filter, state })}
            className={on ? 'chip on' : 'chip'}
            aria-current={on ? 'page' : undefined}
          >
            {label} {counts[count]}
          </Link>
        );
      })}
      <span className="spacer" />
      <form method="get" action="/watches" className="filter-form">
        {filter.state && <input type="hidden" name="state" value={filter.state} />}
        <select name="kind" defaultValue={filter.kind ?? ''} aria-label="Kind">
          <option value="">Kind: any</option>
          {(Object.keys(KIND_LABEL) as WatchKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
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
        <input
          type="search"
          name="q"
          defaultValue={filter.q ?? ''}
          placeholder="Search target…"
          aria-label="Search target"
        />
        <button type="submit" className="btn btn-secondary">
          Filter
        </button>
      </form>
    </div>
  );
}
