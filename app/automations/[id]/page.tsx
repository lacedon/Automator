import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
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
import { canReadWatch } from '../../lib/guard';
import { currentScope } from '../../lib/scope';
import { formatDateTime } from '../../lib/format';

export const dynamic = 'force-dynamic';

type T = Awaited<ReturnType<typeof getTranslations<'AutomationDetail'>>>;
type TKind = Awaited<ReturnType<typeof getTranslations<'Kind'>>>;

function runNowDisabledReason(view: WatchDetailView, jiraEnabled: boolean, t: T): string | undefined {
  if (!view.actions.includes('runNow')) return view.watch.state === 'closed' ? t('reopenFirst') : t('resumeFirst');
  if (view.watch.kind === 'jira' && !jiraEnabled) return t('jiraOff');
  return undefined;
}

function Subline({ watch, t, tKind }: { watch: Watch; t: T; tKind: TKind }) {
  const isUrl = /^https?:\/\//.test(watch.targetUrl);
  return (
    <div className="muted">
      {tKind(watch.kind)} ·{' '}
      {isUrl ? (
        <a href={watch.targetUrl} target="_blank" rel="noreferrer">
          {watch.targetUrl.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        watch.targetUrl
      )}
      {watch.kind === 'mr' && watch.mrSourceBranch !== null && (
        <>
          {t('sourceBranch')}
          <code>{watch.mrSourceBranch}</code>
        </>
      )}
    </div>
  );
}

function SettingsCard({ view, t, locale }: { view: WatchDetailView; t: T; locale: string }) {
  const s = view.settings;
  return (
    <div className="card">
      <h3 className="section-h">{t('settings')}</h3>
      <dl className="kv">
        <dt>{t('repository')}</dt>
        <dd>
          {s.repository} {s.folder !== null && <span className="muted mono">{s.folder}</span>}
        </dd>
        <dt>{t('interval')}</dt>
        <dd>
          {formatDuration(s.intervalMs)}
          {s.intervalIsDefault && <span className="muted"> {t('default')}</span>}
        </dd>
        <dt>{t('model')}</dt>
        <dd>{s.modelIsDefault ? t('defaultModel', { model: s.model }) : s.model}</dd>
        <dt>{t('initialReview')}</dt>
        <dd>
          {s.initialReview}
          {s.initialReviewIsDefault && <span className="muted"> {t('default')}</span>}
        </dd>
        <dt>{t('nextCheck')}</dt>
        <dd>
          <NextCheckLabel next={view.nextCheck} />
        </dd>
        <dt>{t('created')}</dt>
        <dd>{formatDateTime(s.createdAt, locale)}</dd>
      </dl>
    </div>
  );
}

function LastHandledCard({ lines, t }: { lines: string[]; t: T }) {
  if (lines.length === 0) return null;
  return (
    <div className="card">
      <h3 className="section-h">{t('lastHandled')}</h3>
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
  if (!/^\d+$/.test(id) || !(await canReadWatch(Number(id)))) notFound();
  const core = getCore();
  const view = core.read.watchDetail(Number(id));
  if (view === null) notFound();
  const { jiraEnabled: globalJiraEnabled, byRepository } = core.read.formOptions(await currentScope());
  const { watch, running } = view;
  const t = await getTranslations('AutomationDetail');
  const tKind = await getTranslations('Kind');
  const jiraEnabled = byRepository[watch.repository]?.jiraEnabled ?? globalJiraEnabled;

  return (
    <ActionErrorProvider>
      <div className="muted">
        <Link href="/automations">{t('automations')}</Link> /{' '}
        <Link href={`/automations?repo=${encodeURIComponent(watch.repository)}`}>{watch.repository}</Link>
      </div>
      <div className="detail-head">
        <h1 className="detail-title">{watch.name ?? watch.title}</h1>
        <WatchStatePill state={watch.state} />
        <span className="spacer" />
        <div className="actions">
          <RunNowPopover
            watchId={watch.id}
            isMr={watch.kind === 'mr'}
            disabledReason={runNowDisabledReason(view, jiraEnabled, t)}
          />
          <WatchActionBar
            watch={{ id: watch.id, kind: watch.kind, state: watch.state, running: running !== null }}
            actions={view.actions}
            jiraEnabled={jiraEnabled}
          />
        </div>
      </div>
      <Subline watch={watch} t={t} tKind={tKind} />

      <div className="detail-cols">
        <div>
          {watch.state === 'needs_you' && <NeedsYouCard watch={watch} event={view.needsYouEvent} />}
          {running !== null && (
            <div className="row">
              <Pill variant="running">
                ● <Elapsed since={running.startedAt} limitMs={running.timeoutMs} />
              </Pill>
              <Link href={`/runs/${running.runId}`} className="row-text">
                {t('run', { id: running.runId })} <span className="muted">· {running.reason}</span>
              </Link>
              <ConfirmDialog
                label={running.cancelRequested ? t('cancelling') : t('cancel')}
                message={t('cancelMessage')}
                confirmLabel={t('cancelRun')}
                dismissLabel={t('keepRunning')}
                danger
                disabledReason={running.cancelRequested ? t('cancelRequested') : undefined}
                action={cancelRun.bind(null, running.runId)}
              />
            </div>
          )}
          <h2 className="section-h">{t('runs')}</h2>
          <RunsTable runs={view.runs} />
        </div>
        <div className="side-cards">
          <SettingsCard view={view} t={t} locale={await getLocale()} />
          <div className="card">
            <h3 className="section-h">{watch.kind === 'free' ? t('instructions') : t('extraInstructions')}</h3>
            {watch.instructions ? (
              <p className="pre-wrap">{watch.instructions}</p>
            ) : (
              <p className="muted">{t('defaultPrompt')}</p>
            )}
          </div>
          {watch.precheckInstructions !== null && (
            <div className="card">
              <h3 className="section-h">{t('precheck')}</h3>
              <p className="pre-wrap">{watch.precheckInstructions}</p>
              {watch.precheckProblem !== null && (
                <div className="notice" role="alert">
                  {t('precheckProblem', { problem: watch.precheckProblem })}
                </div>
              )}
            </div>
          )}
          {watch.precheckInstructions === null && watch.precheckScript !== null && (
            <div className="card">
              <h3 className="section-h">{t('precheckScript')}</h3>
              <pre className="pre-wrap mono">{watch.precheckScript}</pre>
              {watch.precheckProblem !== null && (
                <div className="notice" role="alert">
                  {t('precheckProblem', { problem: watch.precheckProblem })}
                </div>
              )}
            </div>
          )}
          <LastHandledCard lines={view.lastHandled} t={t} />
        </div>
      </div>
    </ActionErrorProvider>
  );
}
