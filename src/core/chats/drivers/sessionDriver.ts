import type { Env, Secrets } from '../../config/load';
import type { Config } from '../../config/schema';
import type { ProviderName, RunError } from '../../domain/types';
import type { ProviderExit } from '../../runs/providerLauncher';

// Session drivers keep one provider process alive across the turns of an Interactive Chat. They live next to the
// one-shot ProviderLauncher and never replace it.

export type ToolPolicy = { allowAll: boolean; allowed: string[]; blocked: string[]; denyTools: string[] };
export type McpServerSpec = { name: 'automator'; command: string; args: string[]; env: Record<string, string> };

export type TurnStopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error';

export type SessionEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'turn-start'; prompted: boolean }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
  | { type: 'permission'; tool: string; decision: 'allow' | 'deny' } // already answered by policy; log only
  | { type: 'question'; requestId: string; text: string; options: string[] | null } // native (PR 4)
  | { type: 'turn-end'; stopReason: TurnStopReason; error?: RunError }
  | { type: 'error'; error: RunError }
  | { type: 'exit'; exit: ProviderExit };

export type SessionStartOptions = {
  cwd: string;
  model: string;
  env: Env;
  logPath: string; // raw protocol + stderr log, per Chat session
  providerSessionId?: string; // resume; failure => SESSION_RESUME_FAILED, never a silent new session
  tools: ToolPolicy;
  mcpServer?: McpServerSpec; // PR 4+
  scope?: { config: Config; secrets: Secrets };
  // pi keeps its session files here (the Data Dir), not in the user's pi directory.
  sessionDir?: string;
};

export type QuestionAnswer = { kind: 'answer'; text: string } | { kind: 'timeout'; text: string } | { kind: 'cancel' };

export interface SessionHandle {
  readonly pid: number;
  // Resolves after initialize + session/new|load (ACP) or get_state (pi); rejects with a DriverError.
  ready: Promise<{ providerSessionId: string }>;
  send(message: string): Promise<void>; // starts a turn; rejects if a turn is in flight
  respond(requestId: string, answer: QuestionAnswer): void;
  cancelTurn(): void; // ACP session/cancel, pi {"type":"abort"}
  stop(): Promise<ProviderExit>; // close stdin, SIGTERM, SIGKILL after the kill grace
  kill(): void; // immediate SIGKILL of the process group
  onEvent(listener: (event: SessionEvent) => void): () => void;
  exited: Promise<ProviderExit>;
}

export interface SessionDriver {
  readonly provider: ProviderName;
  start(options: SessionStartOptions): SessionHandle;
}

export type SessionDrivers = Partial<Record<ProviderName, SessionDriver>>;

export class DriverError extends Error {
  constructor(readonly runError: RunError) {
    super(runError.message);
    this.name = 'DriverError';
  }
}

export function asRunError(error: unknown, fallbackCode = 'PROVIDER_ERROR'): RunError {
  if (error instanceof DriverError) return error.runError;
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

// Timings of a stop: how long a process gets to exit after stdin closes, then after SIGTERM.
export type StopTimings = { stdinGraceMs: number; killGraceMs: number };
export const DEFAULT_STOP_TIMINGS: StopTimings = { stdinGraceMs: 3_000, killGraceMs: 10_000 };
