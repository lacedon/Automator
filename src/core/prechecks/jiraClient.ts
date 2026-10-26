import type { Config } from '../config/schema';
import { fetchWithRetry, HttpError, type FetchLike } from '../http/fetchWithRetry';

export type JiraIssue = {
  key: string;
  summary: string;
  status: { id: string; name: string; categoryKey: string };
  comments: {
    id: string;
    authorId: string;
    authorName: string;
    body: string;
    created: string;
  }[];
  changelog: {
    id: string;
    authorId: string;
    authorName: string;
    created: string;
    items: {
      field: string;
      fromString: string | null;
      toString: string | null;
    }[];
  }[];
};

export interface JiraClient {
  myself(): Promise<{ accountId: string }>;
  issue(key: string): Promise<JiraIssue>;
  statuses(): Promise<{ id: string; name: string }[]>;
}

// Cloud identifies users by accountId; Server/Data Center by key/name.
type UserJson = {
  accountId?: string;
  key?: string;
  name?: string;
  displayName?: string;
};
type IssueJson = {
  key: string;
  fields: {
    summary: string;
    status: { id: string; name: string; statusCategory: { key: string } };
    comment?: {
      comments: {
        id: string;
        author?: UserJson;
        body: string;
        created: string;
      }[];
    };
  };
  changelog?: {
    histories: {
      id: string;
      author?: UserJson;
      created: string;
      items: {
        field: string;
        fromString?: string | null;
        toString?: string | null;
      }[];
    }[];
  };
};

const userId = (u: UserJson | undefined) => u?.accountId ?? u?.key ?? u?.name ?? '';
const userName = (u: UserJson | undefined) => u?.displayName ?? u?.name ?? 'unknown';

export function jiraBaseUrl(baseUrl: string): string {
  return (/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).replace(/\/+$/, '');
}

// null when the Repository has no Jira connection.
export function jiraBrowseUrl(config: Config, repository: string, key: string): string | null {
  const connection = config.repositories[repository]?.jira;
  const conn = connection === undefined ? undefined : config.jira.connections[connection];
  return conn === undefined ? null : `${jiraBaseUrl(conn.baseUrl)}/browse/${key}`;
}

export function createJiraClient(
  conn: { baseUrl: string },
  secret: { email?: string; token?: string },
  fetchImpl: FetchLike = fetchWithRetry,
): JiraClient {
  const api = `${jiraBaseUrl(conn.baseUrl)}/rest/api/2`;

  async function get<T>(path: string): Promise<T> {
    const { email, token } = secret;
    if (token === undefined || token === '') throw new HttpError('Jira token missing', null, true);
    const authorization = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;
    const res = await fetchImpl(`${api}${path}`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
    });
    return (await res.json()) as T;
  }

  return {
    async myself() {
      return { accountId: userId(await get<UserJson>('/myself')) };
    },
    async issue(key) {
      const query = new URLSearchParams({
        expand: 'changelog',
        fields: 'status,comment,summary',
      });
      const issue = await get<IssueJson>(`/issue/${encodeURIComponent(key)}?${query}`);
      const { status } = issue.fields;
      return {
        key: issue.key,
        summary: issue.fields.summary,
        status: {
          id: status.id,
          name: status.name,
          categoryKey: status.statusCategory.key,
        },
        comments: (issue.fields.comment?.comments ?? []).map((c) => ({
          id: c.id,
          authorId: userId(c.author),
          authorName: userName(c.author),
          body: c.body,
          created: c.created,
        })),
        changelog: (issue.changelog?.histories ?? []).map((h) => ({
          id: h.id,
          authorId: userId(h.author),
          authorName: userName(h.author),
          created: h.created,
          items: h.items.map((i) => ({
            field: i.field,
            fromString: i.fromString ?? null,
            toString: i.toString ?? null,
          })),
        })),
      };
    },
    async statuses() {
      return (await get<{ id: string; name: string }[]>('/status')).map((s) => ({ id: s.id, name: s.name }));
    },
  };
}
