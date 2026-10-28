import type {
  ClosedReason,
  Cursor,
  InitialReview,
  Interrupted,
  NeedsYouEvent,
  Outcome,
  ResultStatus,
  Run,
  RunError,
  RunStatus,
  TeamsStatus,
  Trigger,
  Watch,
  WatchKind,
  WatchState,
} from '../domain/types';

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown): T | null {
  return value === null || value === undefined ? null : (JSON.parse(value as string) as T);
}

export function toWatch(row: unknown): Watch {
  const r = row as Row;
  return {
    id: r.id as number,
    kind: r.kind as WatchKind,
    targetUrl: r.target_url as string,
    normalizedTarget: r.normalized_target as string,
    repository: r.repository as string,
    title: r.title as string,
    state: r.state as WatchState,
    instructions: r.instructions as string | null,
    intervalMs: r.interval_ms as number | null,
    model: r.model as string | null,
    initialReview: r.initial_review as InitialReview | null,
    mrSourceBranch: r.mr_source_branch as string | null,
    cursor: parseJson<Cursor>(r.cursor_json),
    nextCheckAt: r.next_check_at as number | null,
    checkFailures: r.check_failures as number,
    needsYouReason: r.needs_you_reason as string | null,
    needsYouSince: r.needs_you_since as number | null,
    needsYouRunId: r.needs_you_run_id as number | null,
    resolutionNote: r.resolution_note as string | null,
    closedReason: r.closed_reason as ClosedReason | null,
    closedAt: r.closed_at as number | null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function toRun(row: unknown): Run {
  const r = row as Row;
  return {
    id: r.id as number,
    watchId: r.watch_id as number | null,
    repository: r.repository as string,
    status: r.status as RunStatus,
    trigger: r.trigger as Trigger,
    priority: r.priority as number,
    reason: r.reason as string,
    adhocPrompt: r.adhoc_prompt as string | null,
    ticketKey: r.ticket_key as string | null,
    ticketTitle: r.ticket_title as string | null,
    extraInstructions: r.extra_instructions as string | null,
    sessionId: r.session_id as string | null,
    parentRunId: r.parent_run_id as number | null,
    reviewUnresolved: r.review_unresolved === 1,
    model: r.model as string,
    queuedAt: r.queued_at as number,
    startedAt: r.started_at as number | null,
    endedAt: r.ended_at as number | null,
    pid: r.pid as number | null,
    cancelRequestedAt: r.cancel_requested_at as number | null,
    exitCode: r.exit_code as number | null,
    resultStatus: r.result_status as ResultStatus | null,
    outcome: r.outcome as Outcome | null,
    summary: r.summary as string | null,
    error: parseJson<RunError>(r.error_json),
    interrupted: r.interrupted as Interrupted | null,
    cursorCandidate: parseJson<Cursor>(r.cursor_candidate_json),
    branch: r.branch as string | null,
    promptPath: r.prompt_path as string | null,
    transcriptPath: r.transcript_path as string | null,
    resultPath: r.result_path as string | null,
  };
}

export function toNeedsYouEvent(row: unknown): NeedsYouEvent {
  const r = row as Row;
  return {
    id: r.id as number,
    watchId: r.watch_id as number,
    runId: r.run_id as number | null,
    reason: r.reason as string,
    createdAt: r.created_at as number,
    teamsStatus: r.teams_status as TeamsStatus,
    teamsError: r.teams_error as string | null,
  };
}
