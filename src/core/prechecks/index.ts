import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { WatchKind } from '../domain/types';
import { fetchWithRetry, type FetchLike } from '../http/fetchWithRetry';
import { FreeformPrecheck } from './freeform';
import { GitLabPrecheck, type GitLabPrecheckDeps } from './gitlab';
import { createGitLabClient } from './gitlabClient';
import { JiraPrecheck } from './jira';
import { createJiraClient } from './jiraClient';
import type { Precheck } from './types';

export type Prechecks = { mr: Precheck; jira: JiraPrecheck; free: Precheck };

export type PrecheckDeps = {
  config: Config;
  secrets: Secrets;
  fetchImpl?: FetchLike;
  gitlabMeCache?: GitLabPrecheckDeps['meCache'];
};

export function createPrechecks(deps: PrecheckDeps): Prechecks {
  const { config, secrets, fetchImpl = fetchWithRetry } = deps;
  const gitlabClientFor = (conn: string) => createGitLabClient(config.gitlab[conn]!.host, secrets.gitlab[conn], fetchImpl);
  return {
    mr: new GitLabPrecheck({
      config,
      clientFor: gitlabClientFor,
      meCache: deps.gitlabMeCache ?? memoryMeCache(gitlabClientFor),
    }),
    jira: new JiraPrecheck({
      config,
      secrets,
      clientFor: (conn) => createJiraClient(config.jira.connections[conn]!, secrets.jira[conn] ?? {}, fetchImpl),
    }),
    free: new FreeformPrecheck(),
  };
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
