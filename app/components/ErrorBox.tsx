import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { AppError } from '@core/index';
import { formatInterval } from '../lib/format';
import { WatchStatePill } from './Pill';

type SimpleError = Exclude<AppError, { code: 'UNKNOWN_REPOSITORY' | 'DUPLICATE_WATCH' }>;

type T = ReturnType<typeof useTranslations<'ErrorBox'>>;

function describe(error: SimpleError, t: T): string {
  switch (error.code) {
    case 'INVALID_TARGET':
      return error.message;
    case 'MISSING_INSTRUCTIONS':
      return t('instructionsRequired');
    case 'INVALID_INPUT':
      return t('invalidInput', { field: error.field, message: error.message });
    case 'RESTART_FAILED':
    case 'UPGRADE_FAILED':
      return error.message;
    case 'INVALID_STATE':
      return t('invalidState', { action: error.action, state: error.state.replace('_', ' ') });
    case 'RUN_IN_PROGRESS':
      return t('runInProgress', { runId: error.runId });
    case 'JIRA_DISABLED':
      return t('jiraDisabled');
    case 'FORBIDDEN':
      return t('forbidden');
    case 'NOT_FOUND':
      return t('notFound');
  }
}

function basename(file: string): string {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
}

type UnknownRepositoryProps = { error: Extract<AppError, { code: 'UNKNOWN_REPOSITORY' }>; outcome: string };

function UnknownRepository({ error, outcome }: UnknownRepositoryProps) {
  const t = useTranslations('ErrorBox');
  return (
    <>
      <div className="error-title">{t('unknownRepository', { name: error.name })}</div>
      <p>{t('knownRepositories', { outcome, known: error.known.join(', ') })}</p>
      {error.attemptFile !== null && (
        <p className="muted">
          {t('resultFile')} <code>{error.attemptFile}</code>{' '}
          <a
            href={`/files/attempt/${encodeURIComponent(basename(error.attemptFile))}`}
            target="_blank"
            rel="noreferrer"
          >
            {t('open')}
          </a>
        </p>
      )}
      {error.attemptFileError !== undefined && <p>{t('resultFileFailed', { error: error.attemptFileError })}</p>}
    </>
  );
}

function Duplicate({ error }: { error: Extract<AppError, { code: 'DUPLICATE_WATCH' }> }) {
  const t = useTranslations('ErrorBox');
  const { id, state, intervalMs } = error.existing;
  return (
    <>
      <div className="error-title">{t('alreadyAutomated')}</div>
      <p>
        {t('existingAutomation')} <WatchStatePill state={state} />{' '}
        {t('every', { interval: formatInterval(intervalMs) })}.
      </p>
      <p>
        <Link href={`/automations/${id}`}>{t('openExisting')}</Link>
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
export function ErrorBox({ error, unknownRepositoryOutcome }: Props) {
  const t = useTranslations('ErrorBox');
  return (
    <div className="error-box" role="alert">
      {typeof error === 'string' ? (
        <>{t('somethingWrong', { message: error })}</>
      ) : error.code === 'UNKNOWN_REPOSITORY' ? (
        <UnknownRepository error={error} outcome={unknownRepositoryOutcome ?? t('noAutomationCreated')} />
      ) : error.code === 'DUPLICATE_WATCH' ? (
        <Duplicate error={error} />
      ) : (
        <>
          <code>{error.code}</code> {describe(error, t)}
        </>
      )}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
