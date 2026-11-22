import { INTERACTIVE_CAPABILITIES } from '../chats/capabilities';
import { nextFiringTime, timerMessage } from '../chats/timers';
import { toChatSession, toRun } from '../db/rows';
import type {
  ChatMode,
  Interrupted,
  PendingQuestion,
  PendingTimer,
  Outcome,
  Run,
  RunError,
  RunStatus,
  Trigger,
} from '../domain/types';
import { configOf, type ReadDeps } from './deps';
import { readTranscriptExcerpt, type TranscriptExcerpt } from './transcriptExcerpt';

export type ThreadRun = {
  id: number;
  status: RunStatus;
  outcome: Outcome | null;
  request: string | null;
  ticketKey: string | null;
  summary: string | null;
  error: RunError | null;
  interrupted: Interrupted | null;
  closedAt: number | null;
  queuedAt: number;
  endedAt: number | null;
  trigger: Trigger;
  transcript: TranscriptExcerpt | null;
};

// live: a provider process is up; stopped: it will resume on the next message; closing/closed: no more messages.
export type ThreadChatState = 'live' | 'stopped' | 'closing' | 'closed';

// Why a Chat cannot take a reply. Structured so core stays UI-agnostic; the UI renders it per locale.
export type ReplyBlockedReason =
  | { code: 'chat-closed' }
  | { code: 'chat-closing' }
  | { code: 'run-unfinished'; runId: number }
  | { code: 'waiting-answer' }
  | { code: 'no-session' }
  | { code: 'repository-missing'; repository: string }
  | { code: 'repository-invalid'; repository: string; issues: string[] };

export type ThreadView = {
  runs: ThreadRun[];
  replyToRunId: number | null;
  replyBlockedReason: ReplyBlockedReason | null;
  branchedFromRunId: number | null;
  chat: {
    mode: ChatMode;
    sessionId: number | null;
    state: ThreadChatState | null;
    canClose: boolean;
    // Waiting for you: the agent asked something and the Chat waits for the answer.
    question: PendingQuestion | null;
    // The Chat's pending Automator wake-up, and whether its provider has built-in timers that die with the process.
    // firesAt: when it can actually fire (the requested time moved into the Repository's working hours).
    timer: (PendingTimer & { firesAt: number }) | null;
    nativeTimers: boolean;
  };
};

function toThreadRun(deps: ReadDeps, run: Run): ThreadRun {
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    request: run.trigger === 'timer' ? timerMessage(run.adhocPrompt) : run.adhocPrompt,
    ticketKey: run.ticketKey,
    summary: run.summary,
    error: run.error,
    interrupted: run.interrupted,
    closedAt: run.closedAt,
    queuedAt: run.queuedAt,
    endedAt: run.endedAt,
    trigger: run.trigger,
    // A running Run has no recorded path yet; its live file sits at the standard location.
    transcript: readTranscriptExcerpt(run.transcriptPath ?? deps.dataDir.transcriptPath(run.id)),
  };
}

// The Chat's mode is fixed at creation; every Run of an Interactive Chat shares the session of its root.
function chatOf(deps: ReadDeps, run: Run, tip: Run): ThreadView['chat'] {
  if (run.chatSessionId === null)
    return {
      mode: 'follow-up',
      sessionId: null,
      state: null,
      canClose: false,
      question: null,
      timer: null,
      nativeTimers: false,
    };
  const row = deps.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(run.chatSessionId);
  if (row === undefined)
    return {
      mode: 'interactive',
      sessionId: run.chatSessionId,
      state: 'closed',
      canClose: false,
      question: null,
      timer: null,
      nativeTimers: false,
    };
  const session = toChatSession(row);
  const state: ThreadChatState =
    session.closedAt !== null
      ? 'closed'
      : session.closeRequestedAt !== null
        ? 'closing'
        : session.processState === 'stopped'
          ? 'stopped'
          : 'live';
  return {
    mode: 'interactive',
    sessionId: run.chatSessionId,
    state,
    canClose: (state === 'live' || state === 'stopped') && tip.status === 'finished',
    question: state === 'closed' || state === 'closing' ? null : session.question,
    timer:
      state === 'closed' || state === 'closing' || session.timer === null
        ? null
        : {
            ...session.timer,
            firesAt:
              nextFiringTime(session.timer.fireAt, configOf(deps, session.repository).schedule.workingHours) ??
              session.timer.fireAt,
          },
    nativeTimers: INTERACTIVE_CAPABILITIES[session.provider].nativeTimers,
  };
}

export function singleRunThread(deps: ReadDeps, run: Run): ThreadView {
  return {
    runs: [toThreadRun(deps, run)],
    replyToRunId: null,
    replyBlockedReason: null,
    branchedFromRunId: run.branchedFromRunId,
    chat: chatOf(deps, run, run),
  };
}

function replyBlock(deps: ReadDeps, tip: Run, chat: ThreadView['chat']): ReplyBlockedReason | null {
  if (chat.state === 'closed') return { code: 'chat-closed' };
  if (chat.state === 'closing') return { code: 'chat-closing' };
  if (tip.status !== 'finished') return { code: 'run-unfinished', runId: tip.id };
  if (chat.question !== null) return { code: 'waiting-answer' };
  // An Interactive Chat's provider session belongs to the Chat; only Follow-up needs one on the Run.
  if (chat.mode === 'follow-up' && tip.sessionId === null) return { code: 'no-session' };
  const repository = deps.repositories.get(tip.repository);
  if (repository === null) return { code: 'repository-missing', repository: tip.repository };
  const issues = deps.repositories.status(repository.name);
  if (issues.length > 0) return { code: 'repository-invalid', repository: repository.name, issues };
  return null;
}

export function runThread(deps: ReadDeps, run: Run): ThreadView | null {
  if (run.watchId !== null) return null;
  const { db } = deps;
  const parentOf = db.prepare('SELECT * FROM runs WHERE id = ?');
  const childOf = db.prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id LIMIT 1');

  // `seen` guards both walks against a cyclic parent_run_id left by corrupt data.
  const seen = new Set([run.id]);
  let root = run;
  while (root.parentRunId !== null && !seen.has(root.parentRunId)) {
    const parent = parentOf.get(root.parentRunId);
    if (parent === undefined) break;
    root = toRun(parent);
    seen.add(root.id);
  }

  const chain = [root];
  const visited = new Set([root.id]);
  for (let child = childOf.get(root.id); child !== undefined;) {
    const next = toRun(child);
    if (visited.has(next.id)) break;
    visited.add(next.id);
    chain.push(next);
    child = childOf.get(next.id);
  }

  const tip = chain[chain.length - 1]!;
  const chat = chatOf(deps, root.chatSessionId !== null ? root : tip, tip);
  const blocked = replyBlock(deps, tip, chat);
  return {
    runs: chain.map((r) => toThreadRun(deps, r)),
    replyToRunId: blocked === null ? tip.id : null,
    replyBlockedReason: blocked,
    branchedFromRunId: root.branchedFromRunId,
    chat,
  };
}
