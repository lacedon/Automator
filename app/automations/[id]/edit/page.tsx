import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { WatchForm } from '../../../components/WatchForm';
import { getCore } from '../../../lib/core';
import { requireWriteOnWatch } from '../../../lib/guard';
import { currentScope } from '../../../lib/scope';

export const dynamic = 'force-dynamic';

export default async function EditWatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id) || !(await requireWriteOnWatch(Number(id))).ok) notFound();
  const core = getCore();
  const t = await getTranslations('EditWatch');
  const tNew = await getTranslations('NewWatch');
  const watch = core.watches.get(Number(id));
  if (watch === null) notFound();
  const {
    kind,
    targetUrl,
    repository,
    instructions,
    precheckInstructions,
    precheckScript,
    intervalMs,
    model,
    initialReview,
  } = watch;
  return (
    <>
      <div className="muted">
        <Link href="/automations">{tNew('automations')}</Link> /{' '}
        <Link href={`/automations/${watch.id}`}>{watch.name ?? watch.title}</Link> / {t('edit')}
      </div>
      <h1 className="page-title">{t('title', { title: watch.name ?? watch.title })}</h1>
      <WatchForm
        mode="edit"
        options={core.read.formOptions(await currentScope())}
        watch={{
          id: watch.id,
          kind,
          name: watch.name,
          targetUrl,
          repository,
          instructions,
          precheckInstructions,
          precheckScript,
          intervalMs,
          model,
          initialReview,
        }}
      />
    </>
  );
}
