import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { WatchKind } from '../domain/types';
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

export type Prechecks = { mr: Precheck; jira: JiraPrecheck; free: Precheck };

export type PrecheckDeps = {
  config: Config;
  secrets: Secrets;
  fetchImpl?: FetchLike;
  gitlabMeCache?: GitLabPrecheckDeps['meCache'];
  githubMeCache?: GitHubPrecheckDeps['meCache'];
  gitlabClientFor?: GitLabPrecheckDeps['clientFor'];
  githubClientFor?: GitHubPrecheckDeps['clientFor'];
  jiraClientFor?: JiraPrecheckDeps['clientFor'];
};

export function createPrechecks(deps: PrecheckDeps): Prechecks {
  const { config, secrets, fetchImpl = fetchWithRetry } = deps;
  const gitlabClientFor =
    deps.gitlabClientFor ??
    ((conn: string) => createGitLabClient(config.gitlab[conn]!.host, secrets.gitlab[conn], fetchImpl));
  const githubClientFor =
    deps.githubClientFor ??
    ((conn: string) => createGitHubClient(config.github[conn]!.host, secrets.github[conn], fetchImpl));
  return {
    mr: new HostDispatchPrecheck(
      config,
      new GitLabPrecheck({
        config,
        clientFor: gitlabClientFor,
        meCache: deps.gitlabMeCache ?? memoryMeCache(gitlabClientFor),
      }),
      new GitHubPrecheck({
        config,
        clientFor: githubClientFor,
        meCache: deps.githubMeCache ?? memoryMeCache(githubClientFor),
      }),
    ),
    jira: new JiraPrecheck({
      config,
      secrets,
      clientFor:
        deps.jiraClientFor ??
        ((conn) => createJiraClient(config.jira.connections[conn]!, secrets.jira[conn] ?? {}, fetchImpl)),
    }),
    free: new FreeformPrecheck(),
  };
}

// An MR Watch is a GitLab merge request or a GitHub pull request; the target URL decides which.
class HostDispatchPrecheck implements Precheck {
  constructor(
    private readonly config: Config,
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
    const parsed = parseTarget(w.targetUrl, this.config, w.repository);
    return parsed.ok && parsed.value.github !== undefined ? this.github : this.gitlab;
  }
}

export function precheckFor(prechecks: Prechecks, kind: WatchKind): Precheck {
  return prechecks[kind];
}

function memoryMeCache(clientFor: GitLabPrecheckDeps['clientFor']): GitLabPrecheckDeps['meCache'] {
  const cache = new Map<string, ReturnType<GitLabPrecheckDeps['meCache']['get']>>();
  return {
    get(conn) {
      let me = cache.get(conn);
      if (me === undefined) {
        me = clientFor(conn).me();
        me.catch(() => cache.delete(conn));
        cache.set(conn, me);
      }
      return me;
    },
  };
}
