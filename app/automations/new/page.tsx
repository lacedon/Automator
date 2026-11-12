import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { WatchForm } from '../../components/WatchForm';
import { getCore } from '../../lib/core';
import { currentScope } from '../../lib/scope';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewWatchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const t = await getTranslations('NewWatch');
  const options = getCore().read.formOptions(await currentScope());
  const initial = {
    target: first(params.target) ?? '',
    repository: first(params.repository) || (options.repositories[0]?.name ?? ''),
  };
  return (
    <>
      <div className="muted">
        <Link href="/automations">{t('automations')}</Link> / {t('new')}
      </div>
      <h1 className="page-title">{t('title')}</h1>
      <WatchForm mode="create" options={options} initial={initial} />
    </>
  );
}
