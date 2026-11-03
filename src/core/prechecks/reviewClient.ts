// Host-neutral model of a merge/pull request, shared by the GitLab and GitHub clients.
export type ReviewRequest = {
  title: string;
  state: string;
  sha: string;
  sourceBranch: string;
  detailedMergeStatus: string;
  headPipeline: { id: number; status: string; sha: string } | null;
  webUrl: string;
};

export type ReviewNote = {
  id: number;
  system: boolean;
  authorId: number;
  authorUsername: string;
  body: string;
  createdAt: string;
  url?: string;
};

export type ReviewDiscussion = { id: string; resolvable: boolean; resolved: boolean; notes: ReviewNote[] };

export interface ReviewClient {
  me(): Promise<{ id: number; username: string }>;
  mr(projectId: string, iid: number): Promise<ReviewRequest>;
  discussions(projectId: string, iid: number): Promise<ReviewDiscussion[]>;
}
