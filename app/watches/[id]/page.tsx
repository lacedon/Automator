import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { formatDuration, type Watch, type WatchDetailView } from '@core/index';
import { cancelRun } from '../../actions/runs';
import { ActionErrorProvider } from '../../components/ActionButton';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Elapsed } from '../../components/Elapsed';
import { NeedsYouCard } from '../../components/NeedsYouCard';
import { NextCheckLabel, Pill, WatchStatePill } from '../../components/Pill';
import { RunNowPopover } from '../../components/RunNowPopover';
import { RunsTable } from '../../components/RunsTable';
import { WatchActionBar } from '../../components/WatchRowMenu';
import { getCore } from '../../lib/core';
import { formatDateTime } from '../../lib/format';

export const dynamic = 'force-dynamic';

const KIND_TEXT: Record<Watch['kind'], string> = { mr: 'GitLab MR', jira: 'Jira issue', free: 'Free-form' };

function runNowDisabledReason(view: WatchDetailView, jiraEnabled: boolean): string | undefined {
  if (!view.actions.includes('runNow')) return view.watch.state === 'closed' ? 'Reopen the Watch first' : 'Resume the Watch first';
  if (view.watch.kind === 'jira' && !jiraEnabled) return 'Jira checking is off';
  return undefined;
}

function Subline({ watch }: { watch: Watch }) {
  const isUrl = /^https?:\/\//.test(watch.targetUrl);
  return (
    <div className="muted">
      {KIND_TEXT[watch.kind]} ·{' '}
      {isUrl ? (
        <a href={watch.targetUrl} target="_blank" rel="noreferrer">
          {watch.targetUrl.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        watch.targetUrl
      )}
      {watch.kind === 'mr' && watch.mrSourceBranch !== null && (
        <>
          {' · source branch '}
          <code>{watch.mrSourceBranch}</code>
        </>
      )}
    </div>
  );
}

function SettingsCard({ view }: { view: WatchDetailView }) {
  const s = view.settings;
  return (
    <div className="card">
      <h3 className="section-h">Settings</h3>
      <dl className="kv">
        <dt>Repository</dt>
        <dd>
          {s.repository} {s.folder !== null && <span className="muted mono">{s.folder}</span>}
        </dd>
        <dt>Interval</dt>
        <dd>
          {formatDuration(s.intervalMs)}
          {s.intervalIsDefault && <span className="muted"> (default)</span>}
        </dd>
        <dt>Model</dt>
        <dd>{s.modelIsDefault ? `default (${s.model})` : s.model}</dd>
        <dt>Initial review</dt>
        <dd>
          {s.initialReview}
          {s.initialReviewIsDefault && <span className="muted"> (default)</span>}
        </dd>
        <dt>Next check</dt>
        <dd>
          <NextCheckLabel next={view.nextCheck} />
        </dd>
        <dt>Created</dt>
        <dd>{formatDateTime(s.createdAt)}</dd>
      </dl>
    </div>
  );
}

function LastHandledCard({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="card">
      <h3 className="section-h">Last handled point</h3>
      <dl className="kv">
        {lines.map((line) => {
          const at = line.indexOf(': ');
          if (at < 0)
            return (
              <dd key={line} className="kv-full muted">
                {line}
              </dd>
            );
          return (
            <Fragment key={line}>
              <dt>{line.slice(0, at)}</dt>
              <dd>{line.slice(at + 2)}</dd>
            </Fragment>
          );
        })}
      </dl>
    </div>
  );
}

export default async function WatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const core = getCore();
  const view = core.read.watchDetail(Number(id));
  if (view === null) notFound();
  const { jiraEnabled } = core.read.formOptions();
  const { watch, running } = view;

  return (
    <ActionErrorProvider>
      <div className="muted">
        <Link href="/watches">Watches</Link> / <Link href={`/watches?repo=${encodeURIComponent(watch.repository)}`}>{watch.repository}</Link>
      </div>
      <div className="detail-head">
        <h1 className="detail-title">{watch.title}</h1>
        <WatchStatePill state={watch.state} />
        <span className="spacer" />
        <div className="actions">
          <RunNowPopover watchId={watch.id} isMr={watch.kind === 'mr'} disabledReason={runNowDisabledReason(view, jiraEnabled)} />
          <WatchActionBar
            watch={{ id: watch.id, kind: watch.kind, state: watch.state, running: running !== null }}
            actions={view.actions}
            jiraEnabled={jiraEnabled}
          />
        </div>
      </div>
      <Subline watch={watch} />

      <div className="detail-cols">
        <div>
          {watch.state === 'needs_you' && <NeedsYouCard watch={watch} event={view.needsYouEvent} />}
          {running !== null && (
            <div className="row">
              <Pill variant="running">
                ● <Elapsed since={running.startedAt} limitMs={running.timeoutMs} />
              </Pill>
              <Link href={`/runs/${running.runId}`} className="row-text">
                Run #{running.runId} <span className="muted">· {running.reason}</span>
              </Link>
              <ConfirmDialog
                label={running.cancelRequested ? 'Cancelling…' : 'Cancel'}
                message="Cancelling can't undo replies or pushes that already happened."
                confirmLabel="Cancel run"
                dismissLabel="Keep running"
                danger
                disabledReason={running.cancelRequested ? 'Cancel already requested' : undefined}
                action={cancelRun.bind(null, running.runId)}
              />
            </div>
          )}
          <h2 className="section-h">Runs</h2>
          <RunsTable runs={view.runs} />
        </div>
        <div className="side-cards">
          <SettingsCard view={view} />
          <div className="card">
            <h3 className="section-h">{watch.kind === 'free' ? 'Instructions' : 'Extra instructions'}</h3>
            {watch.instructions ? <p className="pre-wrap">{watch.instructions}</p> : <p className="muted">Uses default prompt</p>}
          </div>
          <LastHandledCard lines={view.lastHandled} />
        </div>
      </div>
    </ActionErrorProvider>
  );
}
