import { toRun } from '../db/rows';
import type { ChatMode, Interrupted, Outcome, Run, RunError, RunStatus, Trigger } from '../domain/types';
import type { ReadDeps } from './deps';
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

export type ThreadView = {
  runs: ThreadRun[];
  replyToRunId: number | null;
  replyBlockedReason: string | null;
  branchedFromRunId: number | null;
  chat: { mode: ChatMode; sessionId: number | null };
};

function toThreadRun(deps: ReadDeps, run: Run): ThreadRun {
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    request: run.adhocPrompt,
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
function chatOf(run: Run): ThreadView['chat'] {
  return run.chatSessionId === null
    ? { mode: 'follow-up', sessionId: null }
    : { mode: 'interactive', sessionId: run.chatSessionId };
}

export function singleRunThread(deps: ReadDeps, run: Run): ThreadView {
  return {
    runs: [toThreadRun(deps, run)],
    replyToRunId: null,
    replyBlockedReason: null,
    branchedFromRunId: run.branchedFromRunId,
    chat: chatOf(run),
  };
}

function replyBlock(deps: ReadDeps, tip: Run, interactive: boolean): string | null {
  if (interactive) return 'Interactive Chats are not available yet';
  if (tip.status !== 'finished') return `Waiting for Run #${tip.id} to finish`;
  if (tip.sessionId === null) return 'No Copilot session to continue';
  const repository = deps.repositories.get(tip.repository);
  if (repository === null) return `Repository "${tip.repository}" is no longer configured`;
  const issues = deps.repositories.status(repository.name);
  if (issues.length > 0) return `Repository "${repository.name}" is invalid: ${issues.join('; ')}`;
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
  const blocked = replyBlock(deps, tip, root.chatSessionId !== null || tip.chatSessionId !== null);
  return {
    runs: chain.map((r) => toThreadRun(deps, r)),
    replyToRunId: blocked === null ? tip.id : null,
    replyBlockedReason: blocked,
    branchedFromRunId: root.branchedFromRunId,
    chat: chatOf(root),
  };
}
