import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Run, ThreadView } from '@core/index';
import { RunPill } from '../../components/Pill';
import { RunErrorCard, RunMeta } from '../../components/RunMeta';
import { ChatPane } from '../../components/ChatPane';
import { NoAutoRefresh } from '../../components/NoAutoRefresh';
import { keepsRefreshing } from '../../lib/autoRefresh';
import { getCore } from '../../lib/core';
import { canReadRun } from '../../lib/guard';

export const dynamic = 'force-dynamic';

function singleRunThread(run: Run): ThreadView {
  return {
    runs: [
      {
        id: run.id,
        status: run.status,
        outcome: run.outcome,
        request: run.adhocPrompt,
        ticketKey: run.ticketKey,
        summary: run.summary,
        error: run.error,
        queuedAt: run.queuedAt,
        endedAt: run.endedAt,
      },
    ],
    replyToRunId: null,
    replyBlockedReason: null,
  };
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
      {!keepsRefreshing(run.status, view.thread) && <NoAutoRefresh />}
      <ChatPane thread={view.thread ?? singleRunThread(run)} currentRunId={run.id} />
      <details className="run-details">
        <summary>Run details</summary>
        {run.error !== null && <RunErrorCard error={run.error} />}
        <RunMeta view={view} />
      </details>
    </>
  );
}
