import type { Config } from '../config/schema';
import { parseTarget } from '../domain/targets';
import type { Cursor, MrCursor, Watch } from '../domain/types';
import { HttpError } from '../http/fetchWithRetry';
import type { GitLabClient, GitLabDiscussion, GitLabMr, GitLabNote } from './gitlabClient';
import type { EventSummary, Precheck, PrecheckResult, Snapshot } from './types';

type Me = { id: number; username: string };

export type GitLabPrecheckDeps = {
  clientFor(conn: string): GitLabClient;
  config: Config;
  meCache: { get(conn: string): Promise<Me> };
};

type Analysis = {
  newNotes: GitLabNote[];
  unresolved: GitLabDiscussion[];
  failedPipelineId: number | null;
  pipelinePending: boolean;
  conflicted: boolean;
  conflictPending: boolean;
  maxNoteId: number;
};

function mrCursor(cursor: Cursor | null): MrCursor | null {
  return cursor !== null && typeof (cursor as Partial<MrCursor>).lastNoteId === 'number' ? (cursor as MrCursor) : null;
}

function closeReason(mr: GitLabMr): 'merged' | 'mr-closed' | null {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed') return 'mr-closed';
  return null;
}

function analyze(mr: GitLabMr, discussions: GitLabDiscussion[], me: Me, cursor: MrCursor | null): Analysis {
  const byOther = (n: GitLabNote) => !n.system && n.authorId !== me.id;
  const notes = discussions.flatMap((d) => d.notes);
  const pipeline = mr.headPipeline;
  const failedPipelineId =
    pipeline !== null && pipeline.status === 'failed' && pipeline.sha === mr.sha ? pipeline.id : null;
  const conflicted = mr.detailedMergeStatus === 'conflict';
  return {
    newNotes:
      cursor === null ? [] : notes.filter((n) => byOther(n) && n.id > cursor.lastNoteId).sort((a, b) => a.id - b.id),
    unresolved: discussions.filter((d) => d.resolvable && !d.resolved && d.notes.some(byOther)),
    failedPipelineId,
    pipelinePending: failedPipelineId !== null && failedPipelineId !== cursor?.handledPipelineId,
    conflicted,
    conflictPending: conflicted && mr.sha !== cursor?.handledConflictSha,
    maxNoteId: notes.reduce((max, n) => Math.max(max, n.id), 0),
  };
}

export class GitLabPrecheck implements Precheck {
  constructor(private readonly deps: GitLabPrecheckDeps) {}

  async check(w: Watch): Promise<PrecheckResult> {
    try {
      const { client, projectId, iid, me } = await this.connect(w);
      const mr = await client.mr(projectId, iid);
      const close = closeReason(mr);
      if (close !== null) return { kind: 'close', reason: close };

      const cursor = mrCursor(w.cursor);
      const a = analyze(mr, await client.discussions(projectId, iid), me, cursor);
      const reviewUnresolved = cursor === null && this.initialReview(w) === 'unresolved';
      const reasons: string[] = [];
      if (a.newNotes.length > 0) reasons.push(`new comment by @${a.newNotes[0]!.authorUsername}`);
      if (reviewUnresolved && a.unresolved.length > 0) reasons.push('unresolved discussions');
      if (a.pipelinePending) reasons.push(`pipeline #${a.failedPipelineId} failed`);
      if (a.conflictPending) reasons.push('merge conflict');

      if (reasons.length > 0) return { kind: 'changed', reason: reasons.join('; ') };
      if (cursor === null) {
        return {
          kind: 'unchanged',
          cursor: { lastNoteId: a.maxNoteId, handledPipelineId: null, handledConflictSha: null },
        };
      }
      return { kind: 'unchanged' };
    } catch (e) {
      if (e instanceof HttpError) return { kind: 'failed', auth: e.auth, message: e.message };
      return { kind: 'failed', auth: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async snapshot(w: Watch, opts: { reviewUnresolved: boolean }): Promise<Snapshot> {
    const { client, projectId, iid, me } = await this.connect(w);
    const [mr, discussions] = await Promise.all([client.mr(projectId, iid), client.discussions(projectId, iid)]);
    const cursor = mrCursor(w.cursor);
    const a = analyze(mr, discussions, me, cursor);

    const noteEvents = new Map<number, GitLabNote>(a.newNotes.map((n) => [n.id, n]));
    if (opts.reviewUnresolved || (cursor === null && this.initialReview(w) === 'unresolved')) {
      for (const n of a.unresolved.flatMap((d) => d.notes)) if (!n.system) noteEvents.set(n.id, n);
    }
    const events: EventSummary[] = [...noteEvents.values()]
      .sort((x, y) => x.id - y.id)
      .map((n) => ({
        at: Date.parse(n.createdAt),
        author: `@${n.authorUsername}`,
        text: n.body,
        url: `${mr.webUrl}#note_${n.id}`,
      }));
    if (a.pipelinePending) {
      events.push({
        at: Date.now(),
        author: 'gitlab',
        text: `Pipeline #${a.failedPipelineId} failed on ${mr.sha.slice(0, 8)}`,
      });
    }
    if (a.conflictPending) events.push({ at: Date.now(), author: 'gitlab', text: 'Merge conflict with target branch' });

    const close = closeReason(mr);
    return {
      events,
      cursorCandidate: {
        lastNoteId: Math.max(a.maxNoteId, cursor?.lastNoteId ?? 0),
        handledPipelineId: a.failedPipelineId ?? cursor?.handledPipelineId ?? null,
        handledConflictSha: a.conflicted ? mr.sha : (cursor?.handledConflictSha ?? null),
      },
      title: mr.title,
      sourceBranch: mr.sourceBranch,
      ...(close !== null && { close }),
    };
  }

  private initialReview(w: Watch) {
    return w.initialReview ?? this.deps.config.runs.initialReview;
  }

  private async connect(w: Watch) {
    const parsed = parseTarget(w.targetUrl, this.deps.config, w.repository);
    if (!parsed.ok) throw new Error(`Invalid MR target ${w.targetUrl}`);
    const gitlab = parsed.value.gitlab;
    if (gitlab === undefined) throw new Error(`Not a GitLab merge request: ${w.targetUrl}`);
    const client = this.deps.clientFor(gitlab.conn);
    const me = await this.deps.meCache.get(gitlab.conn);
    return { client, projectId: gitlab.apiProjectId, iid: gitlab.iid, me };
  }
}
