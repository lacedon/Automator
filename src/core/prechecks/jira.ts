import type { Config } from '../config/schema';
import type { Secrets } from '../config/load';
import { parseTarget } from '../domain/targets';
import type { Cursor, JiraCursor, Watch } from '../domain/types';
import { HttpError } from '../http/fetchWithRetry';
import { jiraBaseUrl, type JiraClient, type JiraIssue } from './jiraClient';
import type { EventSummary, Precheck, PrecheckResult, Snapshot } from './types';

export type JiraPrecheckDeps = {
  clientFor(conn: string): JiraClient;
  config: Config;
  secrets: Secrets;
};

type Comment = JiraIssue['comments'][number];
type History = JiraIssue['changelog'][number];

type Analysis = {
  newComments: Comment[];
  newHistories: History[];
  cursor: JiraCursor;
};

const idNum = (id: string | null) => (id === null ? -Infinity : Number(id));
const byId = (a: { id: string }, b: { id: string }) => idNum(a.id) - idNum(b.id);

function maxId(ids: (string | null)[]): string | null {
  return ids.reduce<string | null>((max, id) => (id !== null && idNum(id) > idNum(max) ? id : max), null);
}

// Jira timestamps use "+0000" offsets, which Date.parse does not reliably accept.
function parseJiraTime(value: string): number {
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

function jiraCursor(cursor: Cursor | null): JiraCursor | null {
  return cursor !== null && 'lastChangelogId' in cursor && 'lastCommentId' in cursor ? (cursor as JiraCursor) : null;
}

function analyze(issue: JiraIssue, meId: string, cursor: JiraCursor | null): Analysis {
  const after = (last: string | null) => (entry: { id: string; authorId: string }) =>
    cursor !== null && entry.authorId !== meId && idNum(entry.id) > idNum(last);
  return {
    newComments: issue.comments.filter(after(cursor?.lastCommentId ?? null)).sort(byId),
    newHistories: issue.changelog.filter(after(cursor?.lastChangelogId ?? null)).sort(byId),
    cursor: {
      lastChangelogId: maxId([cursor?.lastChangelogId ?? null, ...issue.changelog.map((h) => h.id)]),
      lastCommentId: maxId([cursor?.lastCommentId ?? null, ...issue.comments.map((c) => c.id)]),
    },
  };
}

function historyReason(h: History): string {
  const status = h.items.find((i) => i.field === 'status');
  if (status !== undefined) return `status changed to ${status.toString}`;
  return `${h.items[0]?.field ?? 'issue'} changed`;
}

function historyText(h: History): string {
  return h.items.map((i) => `${i.field}: ${i.fromString !== null ? `${i.fromString} → ` : ''}${i.toString ?? ''}`).join('; ');
}

export class JiraPrecheck implements Precheck {
  private readonly me = new Map<string, Promise<string>>();

  constructor(private readonly deps: JiraPrecheckDeps) {}

  hasToken(w: Watch): boolean {
    const parsed = parseTarget(w.targetUrl, this.deps.config, w.repository);
    const conn = parsed.ok ? parsed.value.jira?.conn : undefined;
    const token = conn === undefined ? undefined : this.deps.secrets.jira[conn]?.token;
    return token !== undefined && token !== '';
  }

  async check(w: Watch): Promise<PrecheckResult> {
    try {
      const { client, conn, key, meId } = await this.connect(w);
      const issue = await client.issue(key);
      if (this.isDone(conn, issue)) return { kind: 'close', reason: 'jira-done' };

      const cursor = jiraCursor(w.cursor);
      const a = analyze(issue, meId, cursor);
      const reasons: string[] = [];
      if (a.newComments.length > 0) reasons.push(`new comment by ${a.newComments[0]!.authorName}`);
      if (a.newHistories.length > 0) reasons.push(historyReason(a.newHistories[0]!));

      if (reasons.length > 0) return { kind: 'changed', reason: reasons.join('; ') };
      return cursor === null ? { kind: 'unchanged', cursor: a.cursor } : { kind: 'unchanged' };
    } catch (e) {
      if (e instanceof HttpError) return { kind: 'failed', auth: e.auth, message: e.message };
      return {
        kind: 'failed',
        auth: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async snapshot(w: Watch): Promise<Snapshot> {
    if (!this.hasToken(w)) return { events: [], cursorCandidate: w.cursor ?? {}, title: w.title };
    const { client, conn, key, meId } = await this.connect(w);
    const issue = await client.issue(key);
    const a = analyze(issue, meId, jiraCursor(w.cursor));
    const baseUrl = jiraBaseUrl(this.deps.config.jira.connections[conn]!.baseUrl);

    const events: EventSummary[] = [
      ...a.newComments.map((c) => ({
        at: parseJiraTime(c.created),
        author: c.authorName,
        text: c.body,
        url: `${baseUrl}/browse/${issue.key}?focusedCommentId=${c.id}`,
      })),
      ...a.newHistories.map((h) => ({
        at: parseJiraTime(h.created),
        author: h.authorName,
        text: historyText(h),
      })),
    ].sort((x, y) => x.at - y.at);

    return {
      events,
      cursorCandidate: a.cursor,
      title: issue.summary,
      ...(this.isDone(conn, issue) && { close: 'jira-done' as const }),
    };
  }

  private isDone(conn: string, issue: JiraIssue): boolean {
    const ids = this.deps.config.jira.connections[conn]?.doneStatusIds;
    return ids === undefined ? issue.status.categoryKey === 'done' : ids.includes(issue.status.id);
  }

  private async connect(w: Watch) {
    const parsed = parseTarget(w.targetUrl, this.deps.config, w.repository);
    if (!parsed.ok) throw new Error(`Invalid Jira target ${w.targetUrl}`);
    const jira = parsed.value.jira;
    if (jira === undefined) throw new Error(`Not a Jira issue: ${w.targetUrl}`);
    const client = this.deps.clientFor(jira.conn);
    return {
      client,
      conn: jira.conn,
      key: jira.key,
      meId: await this.meFor(jira.conn, client),
    };
  }

  private meFor(conn: string, client: JiraClient): Promise<string> {
    let me = this.me.get(conn);
    if (me === undefined) {
      me = client.myself().then((m) => m.accountId);
      me.catch(() => this.me.delete(conn));
      this.me.set(conn, me);
    }
    return me;
  }
}
