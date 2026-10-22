import Link from 'next/link';
import type { AppError } from '@core/index';
import { formatInterval } from '../lib/format';
import { WatchStatePill } from './Pill';

type SimpleError = Exclude<AppError, { code: 'UNKNOWN_REPOSITORY' | 'DUPLICATE_WATCH' }>;

function describe(error: SimpleError): string {
  switch (error.code) {
    case 'INVALID_TARGET':
      return error.message;
    case 'MISSING_INSTRUCTIONS':
      return 'Instructions are required.';
    case 'INVALID_INPUT':
      return `${error.field}: ${error.message}`;
    case 'INVALID_STATE':
      return `Can't ${error.action} while ${error.state.replace('_', ' ')}.`;
    case 'RUN_IN_PROGRESS':
      return `Run #${error.runId} is in progress.`;
    case 'JIRA_DISABLED':
      return 'Jira is disabled in the config.';
    case 'NOT_FOUND':
      return 'It no longer exists.';
  }
}

function basename(file: string): string {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
}

type UnknownRepositoryProps = { error: Extract<AppError, { code: 'UNKNOWN_REPOSITORY' }>; outcome: string };

function UnknownRepository({ error, outcome }: UnknownRepositoryProps) {
  return (
    <>
      <div className="error-title">Unknown Repository &quot;{error.name}&quot;</div>
      <p>
        {outcome} Known Repositories: {error.known.join(', ')}.
      </p>
      {error.attemptFile !== null && (
        <p className="muted">
          Result file: <code>{error.attemptFile}</code>{' '}
          <a
            href={`/files/attempt/${encodeURIComponent(basename(error.attemptFile))}`}
            target="_blank"
            rel="noreferrer"
          >
            open
          </a>
        </p>
      )}
      {error.attemptFileError !== undefined && <p>The result file could not be written: {error.attemptFileError}</p>}
    </>
  );
}

function Duplicate({ error }: { error: Extract<AppError, { code: 'DUPLICATE_WATCH' }> }) {
  const { id, state, intervalMs } = error.existing;
  return (
    <>
      <div className="error-title">Already watched</div>
      <p>
        This target already has a Watch: <WatchStatePill state={state} /> every {formatInterval(intervalMs)}.
      </p>
      <p>
        <Link href={`/watches/${id}`}>Open existing Watch →</Link>
      </p>
    </>
  );
}

type Props = {
  error: AppError | string;
  // What did not happen because of an unknown Repository, e.g. "No Run was queued."
  unknownRepositoryOutcome?: string;
};

// One red box for every action failure: a domain error, or the message of an unexpected throw.
export function ErrorBox({ error, unknownRepositoryOutcome = 'No Watch was created.' }: Props) {
  return (
    <div className="error-box" role="alert">
      {typeof error === 'string' ? (
        <>Something went wrong: {error}</>
      ) : error.code === 'UNKNOWN_REPOSITORY' ? (
        <UnknownRepository error={error} outcome={unknownRepositoryOutcome} />
      ) : error.code === 'DUPLICATE_WATCH' ? (
        <Duplicate error={error} />
      ) : (
        <>
          <code>{error.code}</code> {describe(error)}
        </>
      )}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
