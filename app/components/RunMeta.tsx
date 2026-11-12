import type { FileView, RunDetailView, RunError, TicketLink } from '@core/index';
import { useTranslations } from 'next-intl';
import { formatDateTime, formatTook } from '../lib/format';
import { Elapsed } from './Elapsed';
import { providerLabel } from '../lib/providerLabel';

export function ticketText(ticket: TicketLink): string {
  return ticket.title === null ? ticket.key : `${ticket.key}: ${ticket.title}`;
}

export function RunItem({
  watchTitle,
  adhocPrompt,
  ticket,
}: {
  watchTitle: string | null;
  adhocPrompt: string | null;
  ticket?: TicketLink | null;
}) {
  const t = useTranslations('RunMeta');
  if (watchTitle !== null) return <>{watchTitle}</>;
  return (
    <>
      <em>{t('adhoc')}</em> {ticket && <strong>{ticketText(ticket)}</strong>}
      {ticket && adhocPrompt !== null && ' '}
      {adhocPrompt !== null && <>“{adhocPrompt}”</>}
    </>
  );
}

function RunTime({ view }: { view: RunDetailView }) {
  const t = useTranslations('RunMeta');
  const { run, tookMs } = view;
  if (run.startedAt === null) return <>{t('queued', { time: formatDateTime(run.queuedAt) })}</>;
  if (run.status === 'running') {
    return (
      <>
        {formatDateTime(run.startedAt)} → {t('running')} <Elapsed since={run.startedAt} />
      </>
    );
  }
  return (
    <>
      {formatDateTime(run.startedAt)} → {run.endedAt === null ? '—' : formatDateTime(run.endedAt)} (
      {tookMs === null ? '—' : formatTook(tookMs)}){run.exitCode !== null && ` · ${t('exit', { code: run.exitCode })}`}
    </>
  );
}

function FileLink({ runId, name, file }: { runId: number; name: string; file: FileView }) {
  const t = useTranslations('RunMeta');
  if (file.content === null) return null;
  return (
    <div>
      <code>{file.path}</code>{' '}
      <a href={`/files/run/${runId}/${name}`} target="_blank" rel="noreferrer">
        {t('open')}
      </a>
    </div>
  );
}

export function RunMeta({ view }: { view: RunDetailView }) {
  const t = useTranslations('RunMeta');
  const tt = useTranslations('Trigger');
  const { run, result, transcript } = view;
  const noFiles = result.content === null && transcript.content === null;
  return (
    <div className="card">
      <dl className="kv">
        <dt>{t('summary')}</dt>
        <dd>{run.summary ?? <span className="muted">—</span>}</dd>
        <dt>{t('trigger')}</dt>
        <dd>
          {tt(run.trigger)} · {run.reason}
        </dd>
        <dt>{t('provider')}</dt>
        <dd>{providerLabel(run.provider)}</dd>
        <dt>{t('time')}</dt>
        <dd>
          <RunTime view={view} />
        </dd>
        <dt>{t('repository')}</dt>
        <dd>
          {run.repository}
          {run.branch !== null && (
            <>
              {` · ${t('branch')} `}
              <code>{run.branch}</code>
            </>
          )}
        </dd>
        {view.ticket && (
          <>
            <dt>{t('ticket')}</dt>
            <dd>
              {view.ticket.url === null ? (
                ticketText(view.ticket)
              ) : (
                <a href={view.ticket.url} target="_blank" rel="noreferrer">
                  {ticketText(view.ticket)}
                </a>
              )}
            </dd>
          </>
        )}
        <dt>{t('files')}</dt>
        <dd>
          <FileLink runId={run.id} name="result.json" file={result} />
          <FileLink runId={run.id} name="transcript.md" file={transcript} />
          {noFiles && <span className="muted">—</span>}
        </dd>
      </dl>
    </div>
  );
}

export function RunErrorCard({ error }: { error: RunError }) {
  return (
    <div className="card card-needs run-error" role="alert">
      <code>{error.code}</code> {error.message}
    </div>
  );
}
