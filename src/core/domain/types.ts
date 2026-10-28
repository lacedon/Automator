export type WatchKind = 'mr' | 'jira' | 'free';
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
  state: WatchState;
  instructions: string | null;
  intervalMs: number | null;
  model: string | null;
  initialReview: InitialReview | null;
  mrSourceBranch: string | null;
  cursor: Cursor | null;
  nextCheckAt: number | null;
  checkFailures: number;
  needsYouReason: string | null;
  needsYouSince: number | null;
  needsYouRunId: number | null;
  resolutionNote: string | null;
  closedReason: ClosedReason | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Run {
  id: number;
  watchId: number | null;
  repository: string;
  status: RunStatus;
  trigger: Trigger;
  priority: number;
  reason: string;
  adhocPrompt: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  extraInstructions: string | null;
  sessionId: string | null;
  parentRunId: number | null;
  reviewUnresolved: boolean;
  model: string;
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
  cursorCandidate: Cursor | null;
  branch: string | null;
  promptPath: string | null;
  transcriptPath: string | null;
  resultPath: string | null;
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
