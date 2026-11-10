import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import { parseTarget } from '../domain/targets';
import type { Watch } from '../domain/types';
import type { RepositoryReader } from '../repositories/repositoryService';
import type { GitHubClient } from './githubClient';
import { MrPrecheck, type Me, type ReviewHost } from './mrPrecheck';

export type GitHubPrecheckDeps = {
  clientFor(conn: string, repository?: string): GitHubClient;
  config: Config;
  configFor?: ConfigFor;
  repositories: RepositoryReader;
  meCache: { get(conn: string, repository?: string): Promise<Me> };
};

export class GitHubPrecheck extends MrPrecheck {
  constructor(deps: GitHubPrecheckDeps) {
    const host: ReviewHost = {
      name: 'github',
      ciName: 'check run',
      async connect(w: Watch) {
        const parsed = parseTarget(w.targetUrl, deps.config, deps.repositories.get(w.repository));
        if (!parsed.ok) throw new Error(`Invalid PR target ${w.targetUrl}`);
        const github = parsed.value.github;
        if (github === undefined) throw new Error(`Not a GitHub pull request: ${w.targetUrl}`);
        const client = deps.clientFor(github.conn, w.repository);
        const me = await deps.meCache.get(github.conn, w.repository);
        return { client, projectId: github.apiProjectId, iid: github.number, me };
      },
    };
    super(host, deps.configFor ?? (() => deps.config));
  }
}
