import type { Secrets } from '../config/load';
import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import type { WatchKind } from '../domain/types';
import type { DataDir } from '../files/dataDir';
import { fetchWithRetry, type FetchLike } from '../http/fetchWithRetry';
import { FreeformPrecheck } from './freeform';
import { GitLabPrecheck, type GitLabPrecheckDeps } from './gitlab';
import { GitHubPrecheck, type GitHubPrecheckDeps } from './github';
import { createGitHubClient } from './githubClient';
import { createGitLabClient } from './gitlabClient';
import { JiraPrecheck, type JiraPrecheckDeps } from './jira';
import { createJiraClient } from './jiraClient';
import type { Precheck, PrecheckResult, Snapshot } from './types';
import { parseTarget } from '../domain/targets';
import type { Watch } from '../domain/types';
import type { RepositoryReader } from '../repositories/repositoryService';

export type Prechecks = { mr: Precheck; jira: JiraPrecheck; free: Precheck };

export type PrecheckDeps = {
  config: Config;
  secrets: Secrets;
  configFor?: ConfigFor;
  secretsFor?: (config: Config) => Secrets;
  repositories: RepositoryReader;
  dataDir?: DataDir;
  fetchImpl?: FetchLike;
  gitlabMeCache?: GitLabPrecheckDeps['meCache'];
  githubMeCache?: GitHubPrecheckDeps['meCache'];
  gitlabClientFor?: GitLabPrecheckDeps['clientFor'];
  githubClientFor?: GitHubPrecheckDeps['clientFor'];
  jiraClientFor?: JiraPrecheckDeps['clientFor'];
};

export function createPrechecks(deps: PrecheckDeps): Prechecks {
  const { config, secrets, repositories, fetchImpl = fetchWithRetry } = deps;
  const configFor: ConfigFor = deps.configFor ?? (() => config);
  const secretsFor = (repository: string): Secrets => deps.secretsFor?.(configFor(repository)) ?? secrets;
  const gitlabClientFor =
    deps.gitlabClientFor ??
    ((conn: string, repository?: string) =>
      createGitLabClient(config.gitlab[conn]!.host, secretsFor(repository ?? '').gitlab[conn], fetchImpl));
  const githubClientFor =
    deps.githubClientFor ??
    ((conn: string, repository?: string) =>
      createGitHubClient(config.github[conn]!.host, secretsFor(repository ?? '').github[conn], fetchImpl));
  return {
    mr: new HostDispatchPrecheck(
      config,
      repositories,
      new GitLabPrecheck({
        config,
        configFor,
        repositories,
        clientFor: gitlabClientFor,
        meCache: deps.gitlabMeCache ?? memoryMeCache(gitlabClientFor),
      }),
      new GitHubPrecheck({
        config,
        configFor,
        repositories,
        clientFor: githubClientFor,
        meCache: deps.githubMeCache ?? memoryMeCache(githubClientFor),
      }),
    ),
    jira: new JiraPrecheck({
      config,
      repositories,
      secrets,
      secretsFor,
      clientFor:
        deps.jiraClientFor ??
        ((conn, repository) =>
          createJiraClient(config.jira.connections[conn]!, secretsFor(repository ?? '').jira[conn] ?? {}, fetchImpl)),
    }),
    free: new FreeformPrecheck(deps.dataDir),
  };
}

// An MR Automation is a GitLab merge request or a GitHub pull request; the target URL decides which.
class HostDispatchPrecheck implements Precheck {
  constructor(
    private readonly config: Config,
    private readonly repositories: RepositoryReader,
    private readonly gitlab: Precheck,
    private readonly github: Precheck,
  ) {}

  check(w: Watch): Promise<PrecheckResult> {
    return this.pick(w).check(w);
  }

  snapshot(w: Watch, opts: { reviewUnresolved: boolean }): Promise<Snapshot> {
    return this.pick(w).snapshot(w, opts);
  }

  private pick(w: Watch): Precheck {
    const parsed = parseTarget(w.targetUrl, this.config, this.repositories.get(w.repository));
    return parsed.ok && parsed.value.github !== undefined ? this.github : this.gitlab;
  }
}

export function precheckFor(prechecks: Prechecks, kind: WatchKind): Precheck {
  return prechecks[kind];
}

function memoryMeCache(clientFor: GitLabPrecheckDeps['clientFor']): GitLabPrecheckDeps['meCache'] {
  const cache = new Map<string, ReturnType<GitLabPrecheckDeps['meCache']['get']>>();
  return {
    get(conn, repository) {
      const key = `${repository ?? ''}\0${conn}`;
      let me = cache.get(key);
      if (me === undefined) {
        me = clientFor(conn, repository).me();
        me.catch(() => cache.delete(key));
        cache.set(key, me);
      }
      return me;
    },
  };
}
