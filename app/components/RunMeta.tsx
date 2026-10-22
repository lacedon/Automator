import type { FileView, RunDetailView, RunError, Trigger } from '@core/index';
import { formatDateTime, formatTook } from '../lib/format';
import { Elapsed } from './Elapsed';

export const TRIGGER_NAME: Record<Trigger, string> = { schedule: 'schedule', manual: 'manual', adhoc: 'ad-hoc' };

export function RunItem({ watchTitle, adhocPrompt }: { watchTitle: string | null; adhocPrompt: string | null }) {
  if (watchTitle !== null) return <>{watchTitle}</>;
  return (
    <>
      <em>ad-hoc:</em> “{adhocPrompt}”
    </>
  );
}

function RunTime({ view }: { view: RunDetailView }) {
  const { run, tookMs } = view;
  if (run.startedAt === null) return <>queued {formatDateTime(run.queuedAt)} · not started</>;
  if (run.status === 'running') {
    return (
      <>
        {formatDateTime(run.startedAt)} → running <Elapsed since={run.startedAt} />
      </>
    );
  }
  return (
    <>
      {formatDateTime(run.startedAt)} → {run.endedAt === null ? '—' : formatDateTime(run.endedAt)} (
      {tookMs === null ? '—' : formatTook(tookMs)}){run.exitCode !== null && ` · exit ${run.exitCode}`}
    </>
  );
}

function FileLink({ runId, name, file }: { runId: number; name: string; file: FileView }) {
  if (file.content === null) return null;
  return (
    <div>
      <code>{file.path}</code>{' '}
      <a href={`/files/run/${runId}/${name}`} target="_blank" rel="noreferrer">
        open
      </a>
    </div>
  );
}

export function RunMeta({ view }: { view: RunDetailView }) {
  const { run, result, transcript } = view;
  const noFiles = result.content === null && transcript.content === null;
  return (
    <div className="card">
      <dl className="kv">
        <dt>Summary</dt>
        <dd>{run.summary ?? <span className="muted">—</span>}</dd>
        <dt>Trigger</dt>
        <dd>
          {TRIGGER_NAME[run.trigger]} · {run.reason}
        </dd>
        <dt>Time</dt>
        <dd>
          <RunTime view={view} />
        </dd>
        <dt>Repository</dt>
        <dd>
          {run.repository}
          {run.branch !== null && (
            <>
              {' · branch '}
              <code>{run.branch}</code>
            </>
          )}
        </dd>
        <dt>Files</dt>
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
