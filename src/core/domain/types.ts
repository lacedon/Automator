export type WatchKind = 'mr' | 'jira' | 'free';
export type WorkflowType = 'mr-watch' | 'jira-watch' | 'free-watch' | 'ticket-adhoc' | 'free-adhoc';
export type ProviderName = 'copilot' | 'claude-code' | 'codex' | 'opencode';
export type WatchState = 'active' | 'paused' | 'needs_you' | 'closed';
export type RunStatus = 'queued' | 'running' | 'finished';
export type Trigger = 'schedule' | 'manual' | 'adhoc';
export type Outcome = 'nothing' | 'acted' | 'needs-you';
export type Interrupted = 'timeout' | 'cancelled' | 'worker-restart';
export type ClosedReason = 'merged' | 'mr-closed' | 'jira-done' | 'user';
export type InitialReview = 'baseline-only' | 'unresolved';
export type ResultStatus = 'success' | 'error';
export type TeamsStatus = 'pending' | 'sent' | 'failed' | 'disabled';

export type MrCursor = { lastNoteId: number; handledPipelineId: number | null; handledConflictSha: string | null };
export type JiraCursor = { lastChangelogId: string | null; lastCommentId: string | null };
export type Cursor = MrCursor | JiraCursor | Record<string, never>;

export type RunError = { code: string; message: string; detail?: unknown };

export interface Watch {
  id: number;
  kind: WatchKind;
  targetUrl: string;
  normalizedTarget: string;
  repository: string;
  title: string;
  // Optional user-given name; shown instead of the title wherever the Automation is listed.
  name: string | null;
  state: WatchState;
  instructions: string | null;
  intervalMs: number | null;
  model: string | null;
  agentId: number | null;
  initialReview: InitialReview | null;
  mrSourceBranch: string | null;
  cursor: Cursor | null;
  nextCheckAt: number | null;
  checkFailures: number;
  needsYouReason: string | null;
  needsYouSince: number | null;
  needsYouRunId: number | null;
  precheckInstructions: string | null;
  precheckScript: string | null;
  precheckOutput: string | null;
  precheckProblem: string | null;
  resolutionNote: string | null;
  closedReason: ClosedReason | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Run {
  id: number;
  watchId: number | null;
  workflowType: WorkflowType;
  repository: string;
  status: RunStatus;
  trigger: Trigger;
  priority: number;
  provider: ProviderName;
  reason: string;
  adhocPrompt: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  extraInstructions: string | null;
  sessionId: string | null;
  parentRunId: number | null;
  branchedFromRunId: number | null;
  branchContext: string | null;
  reviewUnresolved: boolean;
  model: string;
  agentId: number | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  pid: number | null;
  cancelRequestedAt: number | null;
  exitCode: number | null;
  resultStatus: ResultStatus | null;
  outcome: Outcome | null;
  summary: string | null;
  error: RunError | null;
  interrupted: Interrupted | null;
  closedAt: number | null;
  cursorCandidate: Cursor | null;
  branch: string | null;
  promptPath: string | null;
  transcriptPath: string | null;
  resultPath: string | null;
}

export interface Agent {
  id: number;
  name: string;
  instructions: string;
  allowAllTools: boolean;
  allowedTools: string[];
  blockedTools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentAssignment {
  repository: string | null;
  workflowType: WorkflowType;
  agentId: number | null;
}

export interface OperationTemplate {
  workflowType: WorkflowType;
  instructions: string;
}

export interface NeedsYouEvent {
  id: number;
  watchId: number;
  runId: number | null;
  reason: string;
  createdAt: number;
  teamsStatus: TeamsStatus;
  teamsError: string | null;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Project {
  id: number;
  name: string;
  repositories: string[];
  promptAddition: string;
}

// null: all work; 'none': work of repositories that belong to no Project; number: one Project;
// object: the union of the listed Projects (and, when `unassigned`, repositories without a Project).
export type ProjectScope = number | 'none' | null | { projects: number[]; unassigned: boolean };
