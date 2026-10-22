import Link from 'next/link';
import { WatchForm } from '../../components/WatchForm';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewWatchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const options = getCore().read.formOptions();
  const initial = {
    target: first(params.target) ?? '',
    repository: first(params.repository) || (options.repositories[0]?.name ?? ''),
  };
  return (
    <>
      <div className="muted">
        <Link href="/watches">Watches</Link> / New
      </div>
      <h1 className="page-title">New Watch</h1>
      <WatchForm mode="create" options={options} initial={initial} />
    </>
  );
}
