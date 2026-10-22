import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig, loadDotenv, resolveSecrets, type Secrets } from './config/load';
import type { Config } from './config/schema';
import { migrate } from './db/migrate';
import { openDb, type Database } from './db/open';
import { systemClock, type Clock, type NeedsYouEvent } from './domain/types';
import { DataDir } from './files/dataDir';
import { CleanupService } from './cleanup/cleanupService';
import { createTeamsNotifier, type Notifier } from './notify/teamsNotifier';
import { createGitLabClient, type GitLabClient } from './prechecks/gitlabClient';
import type { GitLabPrecheckDeps } from './prechecks/gitlab';
import { createPrechecks } from './prechecks/index';
import { createJiraClient, type JiraClient } from './prechecks/jiraClient';
import { QueueService } from './queue/queueService';
import { createReadModels, type ReadModels } from './read-models/index';
import { createCopilotLauncher, type CopilotLauncher } from './runs/copilotLauncher';
import { RunExecutor, type RunExecutorDeps } from './runs/runExecutor';
import { Scheduler } from './scheduler/scheduler';
import { WatchService, type WatchServiceDeps } from './watches/watchService';

export { ConfigError, loadConfig, loadDotenv, resolveSecrets, type Secrets } from './config/load';
export type { Config } from './config/schema';
export type { Database } from './db/open';
export * from './domain/types';
export { err, ok, type AppError, type Result } from './domain/result';
export { formatDuration, parseDuration } from './domain/duration';
export { intervalFor } from './domain/schedule';
export { allowedActions, nextState, type WatchAction } from './domain/watchState';
export { parseTarget, type ParsedTarget } from './domain/targets';
export { DataDir } from './files/dataDir';
export { CleanupService } from './cleanup/cleanupService';
export type { Notifier } from './notify/teamsNotifier';
export type { GitLabClient, GitLabDiscussion, GitLabMr, GitLabNote } from './prechecks/gitlabClient';
export type { JiraClient, JiraIssue } from './prechecks/jiraClient';
export { QueueService, type EnqueueAdhocInput, type EnqueueWatchInput } from './queue/queueService';
export type { CopilotExit, CopilotLauncher, RunningProcess } from './runs/copilotLauncher';
export type { RunFinal } from './runs/outcomeApplier';
export { recoverInterruptedRuns } from './runs/recovery';
export type * from './read-models/index';
export { RunExecutor, type ResultFileV1, type RunExecutorDeps } from './runs/runExecutor';
export { Scheduler } from './scheduler/scheduler';
export {
  WatchService,
  type CreateWatchInput,
  type PreviewTargetResult,
  type TargetPreview,
  type UpdateWatchInput,
} from './watches/watchService';
export { acquireWorkerLock, heartbeat, isProcessAlive, releaseWorkerLock, type WorkerRunning } from './worker/lock';
export { resolveJiraDoneNames } from './worker/jiraDoneNames';

export interface Deps {
  clock: Clock;
  gitlab: (conn: string) => GitLabClient;
  jira: (conn: string) => JiraClient;
  copilot: CopilotLauncher;
  notifier: Notifier;
}

export interface Core {
  config: Config;
  db: Database;
  dataDir: DataDir;
  deps: Deps;
  executorDeps: RunExecutorDeps;
  watches: WatchService;
  queue: QueueService;
  scheduler: Scheduler;
  executor: RunExecutor;
  cleanup: CleanupService;
  notifier: Notifier;
  read: ReadModels;
  close(): void;
}

function upsertMeta(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

// Keyed by a token hash too: a token of another user must not reuse the old identity.
function metaMeCache(db: Database, gitlab: Deps['gitlab'], secrets: Secrets): GitLabPrecheckDeps['meCache'] {
  return {
    async get(conn) {
      const key = `gitlab_me:${conn}`;
      const tokenHash = createHash('sha256')
        .update(secrets.gitlab[conn] ?? '')
        .digest('hex')
        .slice(0, 16);
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      const cached =
        row === undefined ? null : (JSON.parse(row.value) as { id: number; username: string; tokenHash?: string });
      if (cached !== null && cached.tokenHash === tokenHash) return { id: cached.id, username: cached.username };
      const { id, username } = await gitlab(conn).me();
      upsertMeta(db, key, JSON.stringify({ id, username, tokenHash }));
      return { id, username };
    },
  };
}

function gitlabPreview(gitlab: Deps['gitlab']): NonNullable<WatchServiceDeps['preview']> {
  return async (target) => {
    if (target.kind !== 'mr' || target.gitlab === undefined) return null;
    const mr = await gitlab(target.gitlab.conn).mr(target.gitlab.apiProjectId, target.gitlab.iid);
    return { title: mr.title, state: mr.state, sourceBranch: mr.sourceBranch };
  };
}

export function createCore(config: Config, overrides: Partial<Deps> = {}): Core {
  const secrets = resolveSecrets(config, process.env);
  const dataDir = new DataDir(config.dataDir);
  const db = openDb(dataDir.db);
  migrate(db);

  const copilot = overrides.copilot ?? createCopilotLauncher(config, secrets);
  const deps: Deps = {
    clock: overrides.clock ?? systemClock,
    gitlab: overrides.gitlab ?? ((conn) => createGitLabClient(config.gitlab[conn]!.host, secrets.gitlab[conn])),
    jira: overrides.jira ?? ((conn) => createJiraClient(config.jira.connections[conn]!, secrets.jira[conn] ?? {})),
    copilot,
    notifier: overrides.notifier ?? createTeamsNotifier({ db, config, launcher: copilot, dataDir, secrets }),
  };
  const { clock, notifier } = deps;
  const onNeedsYou = (e: NeedsYouEvent) => notifier.notifyNeedsYou(e);

  const prechecks = createPrechecks({
    config,
    secrets,
    gitlabClientFor: deps.gitlab,
    jiraClientFor: deps.jira,
    gitlabMeCache: metaMeCache(db, deps.gitlab, secrets),
  });
  const queue = new QueueService(db, clock, dataDir, config);
  const executorDeps: RunExecutorDeps = { db, clock, config, dataDir, launcher: copilot, prechecks, onNeedsYou };

  return {
    config,
    db,
    dataDir,
    deps,
    executorDeps,
    watches: new WatchService({ db, clock, config, queue, dataDir, preview: gitlabPreview(deps.gitlab) }),
    queue,
    scheduler: new Scheduler({ db, clock, config, queue, prechecks, onNeedsYou }),
    executor: new RunExecutor(executorDeps),
    cleanup: new CleanupService({ db, clock, config, dataDir }),
    notifier,
    read: createReadModels({ db, config, clock, dataDir }),
    close() {
      if (db.open) db.close();
    },
  };
}

export function bootstrap(opts: { configPath?: string } = {}): Core {
  const file = path.resolve(opts.configPath ?? process.env.AUTOMATOR_CONFIG ?? 'automator.config.json');
  loadDotenv(path.dirname(file));
  return createCore(loadConfig({ path: file }));
}
