import type { Config } from '../config/schema';
import { parseTarget } from '../domain/targets';
import type { Watch } from '../domain/types';
import type { GitLabClient } from './gitlabClient';
import { MrPrecheck, type Me, type ReviewHost } from './mrPrecheck';

export type GitLabPrecheckDeps = {
  clientFor(conn: string): GitLabClient;
  config: Config;
  meCache: { get(conn: string): Promise<Me> };
};

export class GitLabPrecheck extends MrPrecheck {
  constructor(deps: GitLabPrecheckDeps) {
    const host: ReviewHost = {
      name: 'gitlab',
      ciName: 'pipeline',
      async connect(w: Watch) {
        const parsed = parseTarget(w.targetUrl, deps.config, w.repository);
        if (!parsed.ok) throw new Error(`Invalid MR target ${w.targetUrl}`);
        const gitlab = parsed.value.gitlab;
        if (gitlab === undefined) throw new Error(`Not a GitLab merge request: ${w.targetUrl}`);
        const client = deps.clientFor(gitlab.conn);
        const me = await deps.meCache.get(gitlab.conn);
        return { client, projectId: gitlab.apiProjectId, iid: gitlab.iid, me };
      },
    };
    super(host, deps.config);
  }
}
