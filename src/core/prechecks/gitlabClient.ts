import { fetchWithRetry, HttpError, type FetchLike } from '../http/fetchWithRetry';

export type GitLabMr = {
  title: string;
  state: string;
  sha: string;
  sourceBranch: string;
  detailedMergeStatus: string;
  headPipeline: { id: number; status: string; sha: string } | null;
  webUrl: string;
};

export type GitLabNote = {
  id: number;
  system: boolean;
  authorId: number;
  authorUsername: string;
  body: string;
  createdAt: string;
};

export type GitLabDiscussion = { id: string; resolvable: boolean; resolved: boolean; notes: GitLabNote[] };

export interface GitLabClient {
  me(): Promise<{ id: number; username: string }>;
  mr(projectId: string, iid: number): Promise<GitLabMr>;
  discussions(projectId: string, iid: number): Promise<GitLabDiscussion[]>;
}

type NoteJson = {
  id: number;
  system: boolean;
  author: { id: number; username: string };
  body: string;
  created_at: string;
  resolvable?: boolean;
  resolved?: boolean;
};
type DiscussionJson = { id: string; notes: NoteJson[] };
type MrJson = {
  title: string;
  state: string;
  sha: string;
  source_branch: string;
  detailed_merge_status: string;
  head_pipeline: { id: number; status: string; sha: string } | null;
  web_url: string;
};

function toDiscussion(d: DiscussionJson): GitLabDiscussion {
  const resolvableNotes = d.notes.filter((n) => n.resolvable);
  const resolvable = resolvableNotes.length > 0;
  return {
    id: d.id,
    resolvable,
    resolved: resolvable && resolvableNotes.every((n) => n.resolved),
    notes: d.notes.map((n) => ({
      id: n.id,
      system: n.system,
      authorId: n.author.id,
      authorUsername: n.author.username,
      body: n.body,
      createdAt: n.created_at,
    })),
  };
}

export function createGitLabClient(host: string, token: string | undefined, fetchImpl: FetchLike = fetchWithRetry): GitLabClient {
  const origin = (/^https?:\/\//i.test(host) ? host : `https://${host}`).replace(/\/+$/, '');
  const api = `${origin}/api/v4`;

  async function get(path: string): Promise<Response> {
    if (token === undefined || token === '') throw new HttpError('GitLab token missing', null, true);
    return fetchImpl(`${api}${path}`, { headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' } });
  }

  return {
    async me() {
      const user = (await (await get('/user')).json()) as { id: number; username: string };
      return { id: user.id, username: user.username };
    },
    async mr(projectId, iid) {
      const mr = (await (await get(`/projects/${projectId}/merge_requests/${iid}`)).json()) as MrJson;
      return {
        title: mr.title,
        state: mr.state,
        sha: mr.sha,
        sourceBranch: mr.source_branch,
        detailedMergeStatus: mr.detailed_merge_status,
        headPipeline: mr.head_pipeline ? { id: mr.head_pipeline.id, status: mr.head_pipeline.status, sha: mr.head_pipeline.sha } : null,
        webUrl: mr.web_url,
      };
    },
    async discussions(projectId, iid) {
      const all: GitLabDiscussion[] = [];
      let page = '1';
      while (page !== '') {
        const res = await get(`/projects/${projectId}/merge_requests/${iid}/discussions?per_page=100&page=${page}`);
        all.push(...((await res.json()) as DiscussionJson[]).map(toDiscussion));
        page = res.headers.get('x-next-page') ?? '';
      }
      return all;
    },
  };
}
