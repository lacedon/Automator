import { http, HttpResponse } from 'msw';

// Recorded-shape Jira REST v2 payloads (trimmed to the fields Automator reads, plus a few neighbours).

export const JIRA_BASE = 'https://jira.example.com';
export const ISSUE_KEY = 'PAGES-7';
export const ISSUE_URL = `${JIRA_BASE}/browse/${ISSUE_KEY}`;
export const JIRA_EMAIL = 'me@example.com';
export const JIRA_TOKEN = 'test-token';

export const JIRA_USERS = {
  me: {
    accountId: 'me',
    displayName: 'Me Myself',
    emailAddress: JIRA_EMAIL,
    active: true,
  },
  anna: {
    accountId: 'anna-1',
    displayName: 'Anna',
    emailAddress: 'anna@example.com',
    active: true,
  },
  bob: {
    accountId: 'bob-2',
    displayName: 'Bob',
    emailAddress: 'bob@example.com',
    active: true,
  },
} as const;

type User = (typeof JIRA_USERS)[keyof typeof JIRA_USERS];

export const STATUSES = {
  todo: {
    id: '10000',
    name: 'To Do',
    statusCategory: { id: 2, key: 'new', name: 'To Do' },
  },
  inReview: {
    id: '10002',
    name: 'In Review',
    statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' },
  },
  done: {
    id: '10001',
    name: 'Done',
    statusCategory: { id: 3, key: 'done', name: 'Done' },
  },
  closed: {
    id: '10005',
    name: 'Closed',
    statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' },
  },
} as const;

type Status = (typeof STATUSES)[keyof typeof STATUSES];

const at = (id: number) =>
  new Date(Date.parse('2026-10-20T09:00:00Z') + id * 60_000).toISOString().replace('Z', '+0000');

function userJson(user: User) {
  return {
    self: `${JIRA_BASE}/rest/api/2/user?accountId=${user.accountId}`,
    ...user,
    timeZone: 'Europe/Berlin',
  };
}

export function comment(id: number, author: User, body: string, opts: { created?: string } = {}) {
  return {
    self: `${JIRA_BASE}/rest/api/2/issue/10042/comment/${id}`,
    id: String(id),
    author: userJson(author),
    body,
    updateAuthor: userJson(author),
    created: opts.created ?? at(id),
    updated: opts.created ?? at(id),
    jsdPublic: true,
  };
}

export function history(
  id: number,
  author: User,
  items: {
    field: string;
    fromString?: string | null;
    toString: string | null;
  }[],
  opts: { created?: string } = {},
) {
  return {
    id: String(id),
    author: userJson(author),
    created: opts.created ?? at(id),
    items: items.map((i) => ({
      field: i.field,
      fieldtype: 'jira',
      from: null,
      fromString: i.fromString ?? null,
      to: null,
      toString: i.toString,
    })),
  };
}

export type CommentJson = ReturnType<typeof comment>;
export type HistoryJson = ReturnType<typeof history>;

export function issueJson(
  opts: {
    status?: Status;
    comments?: CommentJson[];
    histories?: HistoryJson[];
    summary?: string;
  } = {},
) {
  const comments = opts.comments ?? [];
  const histories = opts.histories ?? [];
  return {
    expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations',
    id: '10042',
    self: `${JIRA_BASE}/rest/api/2/issue/10042`,
    key: ISSUE_KEY,
    fields: {
      summary: opts.summary ?? 'Fix the login page',
      status: {
        self: `${JIRA_BASE}/rest/api/2/status/x`,
        description: '',
        ...(opts.status ?? STATUSES.todo),
      },
      comment: {
        comments,
        maxResults: comments.length,
        total: comments.length,
        startAt: 0,
      },
    },
    changelog: {
      startAt: 0,
      maxResults: histories.length,
      total: histories.length,
      histories,
    },
  };
}

export type JiraFixture = {
  issue?: ReturnType<typeof issueJson>;
  status?: number;
};

const validAuth = new Set([`Basic ${btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`)}`, `Bearer ${JIRA_TOKEN}`]);

// Every request is recorded in `calls` (method + path + query) so tests can assert on traffic.
export function jiraHandlers(fixture: JiraFixture = {}, calls: string[] = []) {
  const api = `${JIRA_BASE}/rest/api/2`;
  const record = (request: Request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (!validAuth.has(request.headers.get('Authorization') ?? '')) {
      return HttpResponse.json(
        {
          errorMessages: ['Client must be authenticated to access this resource.'],
        },
        { status: 401 },
      );
    }
    if (fixture.status !== undefined) return HttpResponse.json({ errorMessages: ['boom'] }, { status: fixture.status });
    return null;
  };
  return [
    http.get(`${api}/myself`, ({ request }) => record(request) ?? HttpResponse.json(userJson(JIRA_USERS.me))),
    http.get(
      `${api}/issue/${ISSUE_KEY}`,
      ({ request }) => record(request) ?? HttpResponse.json(fixture.issue ?? issueJson()),
    ),
    http.get(`${api}/status`, ({ request }) => record(request) ?? HttpResponse.json(Object.values(STATUSES))),
  ];
}
