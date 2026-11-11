import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Run } from '@core/index';
import { RunPill } from '../../components/Pill';
import { RunErrorCard, RunMeta } from '../../components/RunMeta';
import { RunTabs } from '../../components/RunTabs';
import { NoAutoRefresh } from '../../components/NoAutoRefresh';
import { keepsRefreshing } from '../../lib/autoRefresh';
import { getCore } from '../../lib/core';
import { canReadRun } from '../../lib/guard';

export const dynamic = 'force-dynamic';

function noTranscriptText(run: Run): string {
  if (run.status !== 'finished') return "Live transcript isn't available in v1. It appears when the Run finishes.";
  return run.pid === null ? 'No transcript — the Run failed before Copilot started' : 'No transcript was written.';
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id) || !(await canReadRun(Number(id)))) notFound();
  const view = await getCore().read.runDetail(Number(id));
  if (view === null) notFound();
  const { run, watchTitle } = view;

  return (
    <>
      <div className="muted">
        {run.watchId === null ? (
          <Link href="/runs">Chats</Link>
        ) : (
          <Link href={`/automations/${run.watchId}`}>{watchTitle ?? `Automation #${run.watchId}`}</Link>
        )}{' '}
        / #{run.id}
      </div>
      <div className="detail-head">
        <h1 className="detail-title">
          Run #{run.id} ·{' '}
          {run.watchId === null ? (
            'Ad-hoc run'
          ) : (
            <Link href={`/automations/${run.watchId}`}>{watchTitle ?? `Automation #${run.watchId}`}</Link>
          )}
        </h1>
        <RunPill run={run} />
      </div>
      <RunMeta view={view} />
      {run.error !== null && <RunErrorCard error={run.error} />}
      {!keepsRefreshing(run.status, view.thread) && <NoAutoRefresh />}
      <RunTabs
        transcript={view.transcript}
        result={view.result}
        prompt={view.prompt}
        noTranscript={noTranscriptText(run)}
        thread={view.thread}
        currentRunId={run.id}
      />
    </>
  );
}
