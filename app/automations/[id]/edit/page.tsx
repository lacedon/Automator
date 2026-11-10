import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WatchForm } from '../../../components/WatchForm';
import { getCore } from '../../../lib/core';
import { requireWriteOnWatch } from '../../../lib/guard';
import { currentScope } from '../../../lib/scope';

export const dynamic = 'force-dynamic';

export default async function EditWatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id) || !(await requireWriteOnWatch(Number(id))).ok) notFound();
  const core = getCore();
  const watch = core.watches.get(Number(id));
  if (watch === null) notFound();
  const { kind, targetUrl, repository, instructions, intervalMs, model, initialReview } = watch;
  return (
    <>
      <div className="muted">
        <Link href="/automations">Automations</Link> / <Link href={`/automations/${watch.id}`}>{watch.title}</Link> /
        Edit
      </div>
      <h1 className="page-title">Edit Automation · {watch.title}</h1>
      <WatchForm
        mode="edit"
        options={core.read.formOptions(await currentScope())}
        watch={{ id: watch.id, kind, targetUrl, repository, instructions, intervalMs, model, initialReview }}
      />
    </>
  );
}
