import { toRun } from '../db/rows';
import type { Interrupted, Outcome, Run, RunError, RunStatus } from '../domain/types';
import type { ReadDeps } from './deps';

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
};

export type ThreadView = {
  runs: ThreadRun[];
  replyToRunId: number | null;
  replyBlockedReason: string | null;
  branchedFromRunId: number | null;
};

function toThreadRun(run: Run): ThreadRun {
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
  };
}

function replyBlock(deps: ReadDeps, tip: Run): string | null {
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
  const blocked = replyBlock(deps, tip);
  return {
    runs: chain.map(toThreadRun),
    replyToRunId: blocked === null ? tip.id : null,
    replyBlockedReason: blocked,
    branchedFromRunId: root.branchedFromRunId,
  };
}
