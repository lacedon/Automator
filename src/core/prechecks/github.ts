import type { Config } from '../config/schema';
import { parseTarget } from '../domain/targets';
import type { Watch } from '../domain/types';
import type { GitHubClient } from './githubClient';
import { MrPrecheck, type Me, type ReviewHost } from './mrPrecheck';

export type GitHubPrecheckDeps = {
  clientFor(conn: string): GitHubClient;
  config: Config;
  meCache: { get(conn: string): Promise<Me> };
};

export class GitHubPrecheck extends MrPrecheck {
  constructor(deps: GitHubPrecheckDeps) {
    const host: ReviewHost = {
      name: 'github',
      ciName: 'check run',
      async connect(w: Watch) {
        const parsed = parseTarget(w.targetUrl, deps.config, w.repository);
        if (!parsed.ok) throw new Error(`Invalid PR target ${w.targetUrl}`);
        const github = parsed.value.github;
        if (github === undefined) throw new Error(`Not a GitHub pull request: ${w.targetUrl}`);
        const client = deps.clientFor(github.conn);
        const me = await deps.meCache.get(github.conn);
        return { client, projectId: github.apiProjectId, iid: github.number, me };
      },
    };
    super(host, deps.config);
  }
}
