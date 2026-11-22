'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type { AppError, CopyWork, Skill, ThreadRun, ThreadView } from '@core/index';
import {
  answerQuestion,
  branchRun,
  cancelChatTimer,
  closeChat,
  sendRunMessage,
  type AnswerFormState,
  type BranchFormState,
  type ChatFormState,
} from '../actions/chat';
import { closeRun } from '../actions/runs';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox } from './ErrorBox';
import { PromptInput } from './PromptInput';
import { Pill, RunPill } from './Pill';
import { TranscriptBox } from './TranscriptBox';
import { RunFileLinks } from './RunFileLinks';
import { bubbleTranscript, timerRequestText } from '../lib/chatBubble';
import { formatFullDateTime } from '../lib/format';
import { withSkills } from '../lib/skillSuggestions';

export function canClose(run: Pick<ThreadRun, 'status' | 'outcome' | 'error' | 'interrupted' | 'closedAt'>): boolean {
  return (
    run.status === 'finished' &&
    run.closedAt === null &&
    run.interrupted === null &&
    (run.outcome === 'needs-you' || run.error !== null)
  );
}

// An Interactive Chat's close deletes its working copy: unsaved work needs an explicit confirmation first.
function CloseSessionButton({ runId }: { runId: number }) {
  const t = useTranslations('Chat');
  const dialog = useRef<HTMLDialogElement>(null);
  const [work, setWork] = useState<CopyWork | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [pending, startClose] = useTransition();

  const run = (confirmed: boolean) =>
    startClose(async () => {
      const result = await closeChat(runId, confirmed);
      if (result.ok) {
        dialog.current?.close();
        return;
      }
      if ('needsConfirmation' in result) {
        setWork(result.work);
        dialog.current?.showModal();
        return;
      }
      setError(result.error);
    });

  const details =
    work === null
      ? ''
      : [
          ...(work.uncommitted ? [t('workUncommitted')] : []),
          ...(work.unpushedCommits > 0 ? [t('workUnpushed', { count: work.unpushedCommits })] : []),
        ].join(', ');
  return (
    <>
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => run(false)}>
        {t('closeSession')}
      </button>
      {error !== null && <ErrorBox error={error} />}
      <dialog ref={dialog} className="confirm" onCancel={(e) => pending && e.preventDefault()}>
        <p>
          {work === null
            ? t('closeSessionMessage')
            : work.unknown
              ? t('closeChatWorkUnknown')
              : t('closeChatWorkWarning', { details })}
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending}
            onClick={() => dialog.current?.close()}
          >
            {t('branchCancel')}
          </button>
          <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run(true)}>
            {t('closeSessionConfirm')}
          </button>
        </div>
      </dialog>
    </>
  );
}

function BranchForm({ runId }: { runId: number }) {
  const t = useTranslations('Chat');
  const tError = useTranslations('ErrorBox');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(branchRun, null);
  const [message, setMessage] = useState('');
  const [seen, setSeen] = useState<BranchFormState>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.values.message !== undefined) setMessage(state.values.message);
  }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };
  if (!open) {
    return (
      <button type="button" className="btn" title={t('branchTitle')} onClick={() => setOpen(true)}>
        {t('branch')}
      </button>
    );
  }
  return (
    <form action={formAction} onSubmit={submit} className="watch-form chat-form">
      {state !== null && <ErrorBox error={state.error} unknownRepositoryOutcome={tError('noRunQueued')} />}
      <input type="hidden" name="runId" value={runId} />
      <div className="field">
        <label htmlFor={`branch-message-${runId}`}>{t('branchMessage')}</label>
        <textarea
          id={`branch-message-${runId}`}
          name="message"
          rows={3}
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('branchPlaceholder')}
        />
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {t('branchSubmit')}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          {t('branchCancel')}
        </button>
      </div>
    </form>
  );
}

// The agent asked something: the card replaces the composer until the question is answered. A choice question
// offers its options as buttons plus an "Other answer" field; a free-text question offers a field only.
function QuestionCard({ question, runId }: { question: NonNullable<ThreadView['chat']['question']>; runId: number }) {
  const t = useTranslations('Chat');
  const tPill = useTranslations('Pill');
  const tError = useTranslations('ErrorBox');
  const [state, formAction, pending] = useActionState(answerQuestion, null);
  const [other, setOther] = useState('');
  const titleId = useId();
  const answerId = useId();
  // The card replaces the composer: keyboard and screen reader users land on it instead of on a vanished control.
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus(), []);
  const [seen, setSeen] = useState<AnswerFormState>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setOther('');
    else if (state?.values.answer !== undefined) setOther(state.values.answer);
  }
  const send = (answer: string) => {
    const data = new FormData();
    data.set('runId', String(runId));
    data.set('answer', answer);
    startTransition(() => formAction(data));
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    send(other);
  };
  const failed = state?.ok === false ? state.error : null;
  const choices = question.options;
  const locked = pending || state?.ok === true;
  return (
    <section ref={card} tabIndex={-1} className="question-card" aria-labelledby={titleId}>
      <div className="question-head">
        <Pill variant="waiting">{tPill('waiting')}</Pill>
        <span className="muted">{question.expiredAt === null ? t('questionWaiting') : t('questionExpired')}</span>
      </div>
      <p id={titleId} className="question-text">
        {question.text}
      </p>
      {failed !== null && <ErrorBox error={failed} unknownRepositoryOutcome={tError('noRunQueued')} />}
      {state?.ok && (
        <div className="success-box" role="status">
          {state.value.delivered === 'new-turn' ? t('questionQueued', { id: state.value.runId }) : t('questionSent')}
        </div>
      )}
      {choices !== null && (
        <div className="actions question-options">
          {choices.map((option) => (
            <button key={option} type="button" className="btn" disabled={locked} onClick={() => send(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="watch-form chat-form">
        <div className="field">
          <label htmlFor={answerId}>{choices === null ? t('questionAnswer') : t('questionOther')}</label>
          {choices === null ? (
            <textarea
              id={answerId}
              name="answer"
              rows={3}
              required
              disabled={locked}
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
          ) : (
            <input
              id={answerId}
              name="answer"
              type="text"
              required
              disabled={locked}
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
          )}
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={locked}>
            {t('questionSend')}
          </button>
        </div>
      </form>
    </section>
  );
}

// The Chat's pending Automator wake-up. It fires within the Repository's working hours, so the time shown is the
// earliest one.
function TimerCard({ timer, runId }: { timer: NonNullable<ThreadView['chat']['timer']>; runId: number }) {
  const t = useTranslations('Chat');
  const locale = useLocale();
  const titleId = useId();
  return (
    <section className="timer-card" aria-labelledby={titleId}>
      <p id={titleId} className="timer-title">
        {t('timerTitle')}
      </p>
      <p className="muted">{t('timerFires', { time: formatFullDateTime(timer.fireAt, locale) })}</p>
      <p className="timer-message">{timer.message}</p>
      <div className="actions">
        <ConfirmDialog
          label={t('timerCancel')}
          message={t('timerCancelMessage')}
          confirmLabel={t('timerCancelConfirm')}
          action={() => cancelChatTimer(runId)}
        />
      </div>
    </section>
  );
}

// All text is rendered as React text nodes: no HTML, no Markdown.
function RunExchange({ run, current, waiting }: { run: ThreadRun; current: boolean; waiting: boolean }) {
  const t = useTranslations('Chat');
  const pillRun = {
    status: run.status,
    outcome: run.outcome,
    resultStatus: run.error === null ? null : ('error' as const),
    interrupted: run.interrupted,
    closedAt: run.closedAt,
  };
  const transcript = bubbleTranscript(run);
  const tPill = useTranslations('Pill');
  // The newest Run is where the agent is waiting; its pill says so instead of "running".
  const pill = waiting ? <Pill variant="waiting">{tPill('waiting')}</Pill> : <RunPill run={pillRun} />;
  const transcriptBlock = transcript !== null && <TranscriptBox text={transcript} />;
  return (
    <div className="chat-run">
      <div className="chat-run-head muted">
        <Link href={`/runs/${run.id}`}>{t('run', { id: run.id })}</Link>
        {current && t('thisRun')}
      </div>
      {run.trigger === 'agent' ? (
        <div className="chat-bubble chat-request muted">{t('agentTurn')}</div>
      ) : run.trigger === 'timer' ? (
        <div className="chat-bubble chat-request">
          <div className="muted">{t('timerTurn')}</div>
          {timerRequestText(run.request)}
        </div>
      ) : (
        <div className="chat-bubble chat-request">{run.request ?? run.ticketKey}</div>
      )}
      {run.status === 'finished' ? (
        <div className="chat-bubble chat-agent">
          <div>{pill}</div>
          {transcriptBlock}
          {run.error !== null ? run.error.message : run.summary}
        </div>
      ) : run.status === 'running' ? (
        <div className="chat-bubble chat-agent">
          <div>{pill}</div>
          {transcriptBlock}
        </div>
      ) : (
        <div className="chat-bubble chat-agent muted">{run.status}</div>
      )}
      <div className="chat-run-files muted">
        <RunFileLinks runId={run.id} />
        {run.transcript?.truncated === true && <span> · {t('transcriptTruncated')}</span>}
      </div>
      {run.status === 'finished' && (
        <div className="actions">
          <BranchForm runId={run.id} />
        </div>
      )}
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

export function ChatPane({
  thread,
  currentRunId,
  skills = [],
}: {
  thread: ThreadView;
  currentRunId: number;
  skills?: Skill[];
}) {
  const t = useTranslations('Chat');
  const tError = useTranslations('ErrorBox');
  const [state, formAction, pending] = useActionState(sendRunMessage, null);
  const [message, setMessage] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const commands = withSkills([], skills, { global: t('skillGlobal'), local: t('skillLocal') });

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
      {thread.runs[0]?.trigger === 'adhoc' && (
        <p className="muted chat-mode">
          {thread.chat.mode === 'interactive' ? t('modeInteractive') : t('modeFollowUp')}
        </p>
      )}
      {thread.chat.state !== null && (
        <p className="muted chat-session-state" role="status">
          {t('sessionState', { state: thread.chat.state })}
        </p>
      )}
      {thread.chat.nativeTimers && thread.chat.state !== 'closed' && thread.chat.state !== 'closing' && (
        <p className="muted chat-native-timers">{t('nativeTimerWarning')}</p>
      )}
      {thread.chat.canClose && (
        <div className="actions">
          <CloseSessionButton runId={currentRunId} />
        </div>
      )}
      {thread.branchedFromRunId !== null && (
        <p className="muted">
          <Link href={`/runs/${thread.branchedFromRunId}`}>{t('branchedFrom', { id: thread.branchedFromRunId })}</Link>
        </p>
      )}
      {thread.runs.map((run, index) => (
        <RunExchange
          key={run.id}
          run={run}
          current={run.id === currentRunId}
          waiting={thread.chat.question !== null && index === thread.runs.length - 1}
        />
      ))}
      {thread.chat.timer !== null && (
        <TimerCard timer={thread.chat.timer} runId={thread.runs[thread.runs.length - 1]!.id} />
      )}
      {thread.chat.question !== null ? (
        <QuestionCard question={thread.chat.question} runId={thread.runs[thread.runs.length - 1]!.id} />
      ) : thread.replyToRunId === null ? (
        thread.replyBlockedReason !== null && <p className="muted">{thread.replyBlockedReason}</p>
      ) : (
        <form ref={formRef} action={formAction} onSubmit={submit} className="watch-form chat-form">
          {failed !== null && <ErrorBox error={failed} unknownRepositoryOutcome={tError('noRunQueued')} />}
          {state?.ok && (
            <div className="success-box" role="status">
              {t('queued', { id: state.value.runId })}
            </div>
          )}
          <input type="hidden" name="runId" value={thread.replyToRunId} />
          <div className="field">
            <label htmlFor="chat-message">{t('message')}</label>
            <PromptInput
              id="chat-message"
              name="message"
              value={message}
              onChange={setMessage}
              required
              commands={commands}
              mentions={[]}
              onSubmit={() => formRef.current?.requestSubmit()}
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
