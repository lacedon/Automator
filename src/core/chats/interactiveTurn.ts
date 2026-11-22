import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { Run, RunError } from '../domain/types';
import type { ToolPolicy } from './drivers/sessionDriver';
import { unsupportedPolicy } from './drivers/toolPolicy';

export const MAX_SUMMARY = 500;

type AgentTools = { allowAllTools: boolean; allowedTools: string[]; blockedTools: string[] };

// The same policy the one-shot launchers see, plus runs.denyTools.
export function interactiveToolPolicy(agent: AgentTools | null, config: Config): ToolPolicy {
  return {
    allowAll: agent?.allowAllTools ?? true,
    allowed: agent?.allowedTools ?? [],
    blocked: agent?.blockedTools ?? [],
    denyTools: config.runs.denyTools,
  };
}

export function interactivePolicyError(run: Run, policy: ToolPolicy): RunError | null {
  return unsupportedPolicy(run.provider, policy);
}

// The rules and context go out once; after a successful turn the provider session remembers them.
export function isFirstTurn(db: Database, run: Run): boolean {
  const earlier = db
    .prepare(
      `SELECT 1 FROM runs WHERE chat_session_id = ? AND id <> ? AND status = 'finished' AND result_status = 'success'`,
    )
    .get(run.chatSessionId, run.id);
  return earlier === undefined;
}

export function lastMessageSummary(message: string | null): string {
  return (message ?? '').slice(0, MAX_SUMMARY);
}
