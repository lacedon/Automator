import { http, HttpResponse } from 'msw';

// Recorded-shape GitLab REST v4 payloads (trimmed to the fields Automator reads, plus a few neighbours).

export const GITLAB_HOST = 'https://gitlab.example.com';
export const PROJECT_PATH = 'team/app';
export const MR_IID = 42;
export const MR_URL = `${GITLAB_HOST}/${PROJECT_PATH}/-/merge_requests/${MR_IID}`;
export const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

export const USERS = {
  me: { id: 1, username: 'me', name: 'Me Myself', state: 'active' },
  anna: { id: 2, username: 'anna', name: 'Anna Reviewer', state: 'active' },
  bob: { id: 3, username: 'bob', name: 'Bob Builder', state: 'active' },
} as const;

type User = (typeof USERS)[keyof typeof USERS];

export type NoteJson = ReturnType<typeof note>;
export type DiscussionJson = ReturnType<typeof discussion>;

export function note(
  id: number,
  author: User,
  body: string,
  opts: { system?: boolean; resolvable?: boolean; resolved?: boolean; createdAt?: string } = {},
) {
  return {
    id,
    type: opts.resolvable ? 'DiffNote' : null,
    body,
    author: { ...author, avatar_url: null, web_url: `${GITLAB_HOST}/${author.username}` },
    created_at: opts.createdAt ?? new Date(Date.parse('2026-10-20T09:00:00Z') + id * 60_000).toISOString(),
    updated_at: opts.createdAt ?? new Date(Date.parse('2026-10-20T09:00:00Z') + id * 60_000).toISOString(),
    system: opts.system ?? false,
    noteable_id: 9001,
    noteable_type: 'MergeRequest',
    noteable_iid: MR_IID,
    resolvable: opts.resolvable ?? false,
    resolved: opts.resolved ?? false,
  };
}

export function discussion(id: string, notes: NoteJson[]) {
  return { id, individual_note: notes.length === 1 && !notes[0]!.resolvable, notes };
}

export function mrJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    iid: MR_IID,
    project_id: 77,
    title: 'Add widgets',
    state: 'opened',
    sha: HEAD_SHA,
    source_branch: 'feature/widgets',
    target_branch: 'main',
    detailed_merge_status: 'mergeable',
    has_conflicts: false,
    head_pipeline: { id: 55210, sha: HEAD_SHA, ref: 'feature/widgets', status: 'success' },
    web_url: MR_URL,
    ...overrides,
  };
}

export type GitLabFixture = {
  mr?: ReturnType<typeof mrJson>;
  discussions?: DiscussionJson[];
  pageSize?: number;
  status?: number;
};

// Every request is recorded in `calls` (method + path + query) so tests can assert on traffic.
export function gitlabHandlers(fixture: GitLabFixture = {}, calls: string[] = []) {
  const api = `${GITLAB_HOST}/api/v4`;
  const projectId = encodeURIComponent(PROJECT_PATH);
  const record = (request: Request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers.get('PRIVATE-TOKEN') !== 'test-token') return HttpResponse.json({ message: '401 Unauthorized' }, { status: 401 });
    if (fixture.status !== undefined) return HttpResponse.json({ message: 'boom' }, { status: fixture.status });
    return null;
  };
  return [
    http.get(`${api}/user`, ({ request }) => record(request) ?? HttpResponse.json(USERS.me)),
    http.get(`${api}/projects/${projectId}/merge_requests/${MR_IID}`, ({ request }) => record(request) ?? HttpResponse.json(fixture.mr ?? mrJson())),
    http.get(`${api}/projects/${projectId}/merge_requests/${MR_IID}/discussions`, ({ request }) => {
      const failure = record(request);
      if (failure) return failure;
      const url = new URL(request.url);
      const all = fixture.discussions ?? [];
      const perPage = fixture.pageSize ?? Number(url.searchParams.get('per_page') ?? 20);
      const page = Number(url.searchParams.get('page') ?? 1);
      const hasNext = page * perPage < all.length;
      return HttpResponse.json(all.slice((page - 1) * perPage, page * perPage), {
        headers: { 'x-page': String(page), 'x-next-page': hasNext ? String(page + 1) : '' },
      });
    }),
  ];
}
