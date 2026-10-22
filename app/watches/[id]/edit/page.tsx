import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WatchForm } from '../../../components/WatchForm';
import { getCore } from '../../../lib/core';

export const dynamic = 'force-dynamic';

export default async function EditWatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const core = getCore();
  const watch = core.watches.get(Number(id));
  if (watch === null) notFound();
  const { kind, targetUrl, repository, instructions, intervalMs, model, initialReview } = watch;
  return (
    <>
      <div className="muted">
        <Link href="/watches">Watches</Link> / <Link href={`/watches/${watch.id}`}>{watch.title}</Link> / Edit
      </div>
      <h1 className="page-title">Edit Watch · {watch.title}</h1>
      <WatchForm
        mode="edit"
        options={core.read.formOptions()}
        watch={{ id: watch.id, kind, targetUrl, repository, instructions, intervalMs, model, initialReview }}
      />
    </>
  );
}
