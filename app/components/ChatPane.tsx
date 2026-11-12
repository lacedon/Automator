'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { ThreadRun, ThreadView } from '@core/index';
import { sendRunMessage, type ChatFormState } from '../actions/chat';
import { closeRun } from '../actions/runs';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox } from './ErrorBox';
import { RunPill } from './Pill';
import { RunFileLinks } from './RunFileLinks';

export function canClose(run: Pick<ThreadRun, 'status' | 'outcome' | 'error' | 'interrupted' | 'closedAt'>): boolean {
  return (
    run.status === 'finished' &&
    run.closedAt === null &&
    run.interrupted === null &&
    (run.outcome === 'needs-you' || run.error !== null)
  );
}

// All text is rendered as React text nodes: no HTML, no Markdown.
function RunExchange({ run, current }: { run: ThreadRun; current: boolean }) {
  const t = useTranslations('Chat');
  const pillRun = {
    status: run.status,
    outcome: run.outcome,
    resultStatus: run.error === null ? null : ('error' as const),
    interrupted: run.interrupted,
    closedAt: run.closedAt,
  };
  return (
    <div className="chat-run">
      <div className="chat-run-head muted">
        <Link href={`/runs/${run.id}`}>{t('run', { id: run.id })}</Link>
        {current && t('thisRun')}
      </div>
      <div className="chat-bubble chat-request">{run.request ?? run.ticketKey}</div>
      {run.status === 'finished' ? (
        <div className="chat-bubble chat-agent">
          <div>
            <RunPill run={pillRun} />
          </div>
          {run.error !== null ? run.error.message : run.summary}
        </div>
      ) : (
        <div className="chat-bubble chat-agent muted">{run.status}</div>
      )}
      <div className="chat-run-files muted">
        <RunFileLinks runId={run.id} />
      </div>
      {current && canClose(run) && (
        <div className="actions">
          <ConfirmDialog
            label={t('close')}
            message={t('closeMessage')}
            confirmLabel={t('closeConfirm')}
            action={() => closeRun(run.id)}
          />
        </div>
      )}
    </div>
  );
}

export function ChatPane({ thread, currentRunId }: { thread: ThreadView; currentRunId: number }) {
  const t = useTranslations('Chat');
  const tError = useTranslations('ErrorBox');
  const [state, formAction, pending] = useActionState(sendRunMessage, null);
  const [message, setMessage] = useState('');

  // A successful send clears the message; a failure restores what was submitted.
  const [seen, setSeen] = useState<ChatFormState>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setMessage('');
    else if (state?.values.message !== undefined) setMessage(state.values.message);
  }

  // Submitting manually avoids React's automatic form reset, which would revert the controlled textarea.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };

  const failed = state?.ok === false ? state.error : null;

  return (
    <div className="chat">
      {thread.runs.map((run) => (
        <RunExchange key={run.id} run={run} current={run.id === currentRunId} />
      ))}
      {thread.replyToRunId === null ? (
        thread.replyBlockedReason !== null && <p className="muted">{thread.replyBlockedReason}</p>
      ) : (
        <form action={formAction} onSubmit={submit} className="watch-form chat-form">
          {failed !== null && <ErrorBox error={failed} unknownRepositoryOutcome={tError('noRunQueued')} />}
          {state?.ok && (
            <div className="success-box" role="status">
              {t('queued', { id: state.value.runId })}
            </div>
          )}
          <input type="hidden" name="runId" value={thread.replyToRunId} />
          <div className="field">
            <label htmlFor="chat-message">{t('message')}</label>
            <textarea
              id="chat-message"
              name="message"
              rows={3}
              required
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('placeholder')}
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {t('send')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
