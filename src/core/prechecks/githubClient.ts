import { fetchWithRetry, HttpError, type FetchLike } from '../http/fetchWithRetry';
import type { ReviewClient, ReviewDiscussion, ReviewNote, ReviewRequest } from './reviewClient';

export type GitHubClient = ReviewClient;

type UserJson = { id: number; login: string } | null;
type PullJson = {
  title: string;
  state: string;
  merged: boolean;
  mergeable_state?: string | null;
  html_url: string;
  head: { sha: string; ref: string };
};
type IssueCommentJson = { id: number; user: UserJson; body: string; created_at: string; html_url: string };
type ReviewJson = {
  id: number;
  user: UserJson;
  body: string | null;
  state: string;
  submitted_at?: string | null;
  html_url: string;
};
type CheckRunJson = { id: number; conclusion: string | null };
type GqlComment = {
  databaseId: number;
  author: { login: string; databaseId?: number } | null;
  body: string;
  createdAt: string;
  url: string;
};
type GqlComments = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlComment[] };
type GqlResponse<T> = { data?: T; errors?: { type?: string; message: string }[] };
type ThreadsData = {
  repository?: {
    pullRequest?: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string; isResolved: boolean; comments: GqlComments }[];
      };
    };
  };
};
type ThreadCommentsData = { node?: { comments: GqlComments } | null };

const COMMENT_FIELDS = `databaseId author { login ... on User { databaseId } ... on Bot { databaseId } } body createdAt url`;
const COMMENTS_FIELDS = `pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} }`;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 100) { ${COMMENTS_FIELDS} } }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { ${COMMENTS_FIELDS} } } }
}`;

const AUTH_ERROR_TYPES = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND']);

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

function splitProject(projectId: string): { owner: string; name: string } {
  const [owner = '', name = ''] = projectId.split('/');
  return { owner, name };
}

// Issue comments, review bodies and review comments have separate GitHub ID sequences, so notes get
// a shared ordering key instead: creation time in seconds, with the low digits of the GitHub ID as tie-break.
function noteKey(createdAt: string, githubId: number): number {
  const seconds = Math.floor(Date.parse(createdAt) / 1000);
  return (Number.isNaN(seconds) ? 0 : seconds) * 1_000_000 + (githubId % 1_000_000);
}

function userNote(
  id: number,
  user: UserJson,
  body: string,
  createdAt: string,
  url: string,
): { id: string; resolvable: false; resolved: false; notes: ReviewNote[] } {
  return {
    id: String(id),
    resolvable: false,
    resolved: false,
    notes: [
      {
        id: noteKey(createdAt, id),
        system: false,
        authorId: user?.id ?? 0,
        authorUsername: user?.login ?? 'ghost',
        body,
        createdAt,
        url,
      },
    ],
  };
}

export function createGitHubClient(
  host: string,
  token: string | undefined,
  fetchImpl: FetchLike = fetchWithRetry,
): GitHubClient {
  const origin = (/^https?:\/\//i.test(host) ? host : `https://${host}`).replace(/\/+$/, '');
  const isDotCom = new URL(origin).host.toLowerCase() === 'github.com';
  const api = isDotCom ? 'https://api.github.com' : `${origin}/api/v3`;
  const graphql = isDotCom ? 'https://api.github.com/graphql' : `${origin}/api/graphql`;
  const headers = (): Record<string, string> => {
    if (token === undefined || token === '') throw new HttpError('GitHub token missing', null, true);
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  };

  async function get(urlOrPath: string): Promise<Response> {
    return fetchImpl(urlOrPath.startsWith('http') ? urlOrPath : `${api}${urlOrPath}`, { headers: headers() });
  }

  async function paginate<T>(path: string, pick: (json: unknown) => T[] = (j) => j as T[]): Promise<T[]> {
    const all: T[] = [];
    let next: string | null = `${api}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next !== null) {
      const res: Response = await get(next);
      all.push(...pick(await res.json()));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return all;
  }

  async function query<T>(text: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(graphql, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, variables }),
    });
    const json = (await res.json()) as GqlResponse<T>;
    if (json.data === undefined || json.errors !== undefined) {
      const first = json.errors?.[0];
      throw new HttpError(
        first?.message ?? 'GitHub GraphQL returned no data',
        null,
        first?.type !== undefined && AUTH_ERROR_TYPES.has(first.type),
      );
    }
    return json.data;
  }

  const toNote = (c: GqlComment): ReviewNote => ({
    id: noteKey(c.createdAt, c.databaseId),
    system: false,
    authorId: c.author?.databaseId ?? 0,
    authorUsername: c.author?.login ?? 'ghost',
    body: c.body,
    createdAt: c.createdAt,
    url: c.url,
  });

  async function threadComments(threadId: string, first: GqlComments): Promise<GqlComment[]> {
    const all = [...first.nodes];
    let page = first.pageInfo;
    while (page.hasNextPage) {
      const data = await query<ThreadCommentsData>(THREAD_COMMENTS_QUERY, { id: threadId, after: page.endCursor });
      if (data.node === undefined || data.node === null) break;
      all.push(...data.node.comments.nodes);
      page = data.node.comments.pageInfo;
    }
    return all;
  }

  async function reviewThreads(projectId: string, iid: number): Promise<ReviewDiscussion[]> {
    const { owner, name } = splitProject(projectId);
    const result: ReviewDiscussion[] = [];
    let after: string | null = null;
    for (;;) {
      const data: ThreadsData = await query<ThreadsData>(THREADS_QUERY, { owner, name, number: iid, after });
      const threads = data.repository?.pullRequest?.reviewThreads;
      if (threads === undefined) throw new HttpError('GitHub pull request not found', 404, true);
      for (const t of threads.nodes) {
        result.push({
          id: t.id,
          resolvable: true,
          resolved: t.isResolved,
          notes: (await threadComments(t.id, t.comments)).map(toNote),
        });
      }
      if (!threads.pageInfo.hasNextPage) return result;
      after = threads.pageInfo.endCursor;
    }
  }

  return {
    async me() {
      const user = (await (await get('/user')).json()) as { id: number; login: string };
      return { id: user.id, username: user.login };
    },
    async mr(projectId, iid): Promise<ReviewRequest> {
      const pr = (await (await get(`/repos/${projectId}/pulls/${iid}`)).json()) as PullJson;
      const runs = await paginate<CheckRunJson>(
        `/repos/${projectId}/commits/${pr.head.sha}/check-runs?filter=latest`,
        (j) => (j as { check_runs: CheckRunJson[] }).check_runs,
      );
      const failed = runs.filter((r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion));
      return {
        title: pr.title,
        state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'opened',
        sha: pr.head.sha,
        sourceBranch: pr.head.ref,
        detailedMergeStatus: pr.mergeable_state === 'dirty' ? 'conflict' : (pr.mergeable_state ?? 'unknown'),
        headPipeline:
          failed.length > 0
            ? { id: Math.max(...failed.map((r) => r.id)), status: 'failed', sha: pr.head.sha }
            : { id: 0, status: 'success', sha: pr.head.sha },
        webUrl: pr.html_url,
      };
    },
    async discussions(projectId, iid) {
      const [comments, reviews, threads] = await Promise.all([
        paginate<IssueCommentJson>(`/repos/${projectId}/issues/${iid}/comments`),
        paginate<ReviewJson>(`/repos/${projectId}/pulls/${iid}/reviews`),
        reviewThreads(projectId, iid),
      ]);
      return [
        ...comments.map((c) => userNote(c.id, c.user, c.body, c.created_at, c.html_url)),
        ...reviews
          .filter((r) => r.state !== 'PENDING' && (r.body ?? '') !== '')
          .map((r) => userNote(r.id, r.user, r.body ?? '', r.submitted_at ?? '', r.html_url)),
        ...threads,
      ];
    },
  };
}
