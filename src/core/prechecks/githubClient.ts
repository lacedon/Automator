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
type ThreadsJson = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            isResolved: boolean;
            comments: {
              nodes: {
                databaseId: number;
                author: { login: string; databaseId?: number } | null;
                body: string;
                createdAt: string;
                url: string;
              }[];
            };
          }[];
        };
      };
    };
  };
  errors?: { message: string }[];
};

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes { databaseId author { login ... on User { databaseId } ... on Bot { databaseId } } body createdAt url }
          }
        }
      }
    }
  }
}`;

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

function splitProject(projectId: string): { owner: string; name: string } {
  const [owner = '', name = ''] = projectId.split('/');
  return { owner, name };
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
      { id, system: false, authorId: user?.id ?? 0, authorUsername: user?.login ?? 'ghost', body, createdAt, url },
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

  async function reviewThreads(projectId: string, iid: number): Promise<ReviewDiscussion[]> {
    const { owner, name } = splitProject(projectId);
    const result: ReviewDiscussion[] = [];
    let after: string | null = null;
    for (;;) {
      const res = await fetchImpl(graphql, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: THREADS_QUERY, variables: { owner, name, number: iid, after } }),
      });
      const json = (await res.json()) as ThreadsJson;
      const threads = json.data?.repository?.pullRequest?.reviewThreads;
      if (threads === undefined) {
        throw new HttpError(json.errors?.[0]?.message ?? 'GitHub GraphQL returned no review threads', null, false);
      }
      for (const t of threads.nodes) {
        result.push({
          id: t.id,
          resolvable: true,
          resolved: t.isResolved,
          notes: t.comments.nodes.map((c) => ({
            id: c.databaseId,
            system: false,
            authorId: c.author?.databaseId ?? 0,
            authorUsername: c.author?.login ?? 'ghost',
            body: c.body,
            createdAt: c.createdAt,
            url: c.url,
          })),
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
        `/repos/${projectId}/commits/${pr.head.sha}/check-runs`,
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
