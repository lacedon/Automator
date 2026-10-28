'use client';

import Link from 'next/link';
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { ThreadRun, ThreadView } from '@core/index';
import { sendRunMessage, type ChatFormState } from '../actions/chat';
import { ErrorBox } from './ErrorBox';
import { RunPill } from './Pill';

// All text is rendered as React text nodes: no HTML, no Markdown.
function RunExchange({ run, current }: { run: ThreadRun; current: boolean }) {
  const pillRun = {
    status: run.status,
    outcome: run.outcome,
    resultStatus: run.error === null ? null : ('error' as const),
    interrupted: null,
  };
  return (
    <div className="chat-run">
      <div className="chat-run-head muted">
        <Link href={`/runs/${run.id}`}>Run #{run.id}</Link>
        {current && ' (this Run)'}
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
    </div>
  );
}

export function ChatPane({ thread, currentRunId }: { thread: ThreadView; currentRunId: number }) {
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
        <p className="muted">{thread.replyBlockedReason}</p>
      ) : (
        <form action={formAction} onSubmit={submit} className="watch-form chat-form">
          {failed !== null && <ErrorBox error={failed} unknownRepositoryOutcome="No Run was queued." />}
          {state?.ok && (
            <div className="success-box" role="status">
              Run #{state.value.runId} queued
            </div>
          )}
          <input type="hidden" name="runId" value={thread.replyToRunId} />
          <div className="field">
            <label htmlFor="chat-message">Message</label>
            <textarea
              id="chat-message"
              name="message"
              rows={3}
              required
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Follow up in the same Copilot session…"
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              Send
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
