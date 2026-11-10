import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig, loadDotenv, readRawConfig, type Secrets } from './config/load';
import { ConfigResolver } from './config/resolver';
import type { Config } from './config/schema';
import { migrate } from './db/migrate';
import { openDb, type Database } from './db/open';
import { systemClock, type Clock, type NeedsYouEvent } from './domain/types';
import { DataDir } from './files/dataDir';
import { CleanupService } from './cleanup/cleanupService';
import { AgentService } from './agents/agentService';
import { createTeamsNotifier, type Notifier } from './notify/teamsNotifier';
import { createGitLabClient, type GitLabClient } from './prechecks/gitlabClient';
import type { GitLabPrecheckDeps } from './prechecks/gitlab';
import { createGitHubClient, type GitHubClient } from './prechecks/githubClient';
import { createPrechecks } from './prechecks/index';
import { createJiraClient, type JiraClient } from './prechecks/jiraClient';
import { ProjectService } from './projects/projectService';
import { importLegacyRepositories } from './repositories/legacyImport';
import { RepositoryService } from './repositories/repositoryService';
import { AccessService } from './access/accessService';
import { CredentialService } from './users/credentialService';
import { UserService } from './users/userService';
import { QueueService } from './queue/queueService';
import { createReadModels, type ReadModels } from './read-models/index';
import { createClaudeCodeLauncher } from './runs/claudeCodeLauncher';
import { createCodexLauncher } from './runs/codexLauncher';
import { createCopilotLauncher, type CopilotLauncher } from './runs/copilotLauncher';
import { createOpenCodeLauncher } from './runs/opencodeLauncher';
import type { ProviderLaunchers } from './runs/providerLauncher';
import { RunExecutor, type RunExecutorDeps } from './runs/runExecutor';
import { Scheduler } from './scheduler/scheduler';
import { WatchService, type WatchServiceDeps } from './watches/watchService';

export { ConfigError, loadConfig, loadDotenv, resolveSecrets, type Secrets } from './config/load';
export { readEditableConfig, writeEditableConfig, type EditableConfig } from './config/editor';
export type { Config } from './config/schema';
export { ConfigResolver, type ConfigFor } from './config/resolver';
export type { OverrideRow, OverrideValues } from './config/overrides';
export type { Database } from './db/open';
export * from './domain/types';
export { err, ok, type AppError, type Result } from './domain/result';
export { formatDuration, parseDuration } from './domain/duration';
export { intervalFor } from './domain/schedule';
export { allowedActions, nextState, type WatchAction } from './domain/watchState';
export { parseTarget, type ParsedTarget } from './domain/targets';
export { DataDir } from './files/dataDir';
export { CleanupService } from './cleanup/cleanupService';
export { AgentService } from './agents/agentService';
export { ProjectService } from './projects/projectService';
export {
  ADMIN_ROLE,
  AccessService,
  PERMISSIONS,
  type Permission,
  type Role,
  type RoleAssignment,
} from './access/accessService';
export { copilotAuthEnvNames } from './runs/childProcess';
export { CredentialService } from './users/credentialService';
export { SESSION_TTL_MS, UserService, type ApiToken, type User } from './users/userService';
export { RepositoryService, type Repository, type RepositoryInput } from './repositories/repositoryService';
export type { Notifier } from './notify/teamsNotifier';
export type { GitLabClient, GitLabDiscussion, GitLabMr, GitLabNote } from './prechecks/gitlabClient';
export type { GitHubClient } from './prechecks/githubClient';
export type { ReviewClient, ReviewDiscussion, ReviewNote, ReviewRequest } from './prechecks/reviewClient';
export type { JiraClient, JiraIssue } from './prechecks/jiraClient';
export {
  MAX_FOLLOW_UP_CHARS,
  QueueService,
  type EnqueueAdhocInput,
  type EnqueueWatchInput,
} from './queue/queueService';
export type { CopilotExit, CopilotLauncher, RunningProcess } from './runs/copilotLauncher';
export type { ProviderExit, ProviderLauncher, ProviderLaunchers, ProviderStartOptions } from './runs/providerLauncher';
export { createClaudeCodeLauncher } from './runs/claudeCodeLauncher';
export { createCodexLauncher } from './runs/codexLauncher';
export { createOpenCodeLauncher } from './runs/opencodeLauncher';
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
  gitlab: (conn: string, repository?: string) => GitLabClient;
  github: (conn: string, repository?: string) => GitHubClient;
  jira: (conn: string, repository?: string) => JiraClient;
  copilot: CopilotLauncher;
  launchers: ProviderLaunchers;
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
  agents: AgentService;
  projects: ProjectService;
  users: UserService;
  credentials: CredentialService;
  access: AccessService;
  configs: ConfigResolver;
  repositories: RepositoryService;
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
function metaMeCache(
  db: Database,
  host: 'gitlab' | 'github',
  clientFor: Deps['gitlab'] | Deps['github'],
  secretsFor: (repository?: string) => Secrets,
): GitLabPrecheckDeps['meCache'] {
  return {
    async get(conn, repository) {
      const key = `${host}_me:${conn}`;
      const tokenHash = createHash('sha256')
        .update(secretsFor(repository)[host][conn] ?? '')
        .digest('hex')
        .slice(0, 16);
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      const cached =
        row === undefined ? null : (JSON.parse(row.value) as { id: number; username: string; tokenHash?: string });
      if (cached !== null && cached.tokenHash === tokenHash) return { id: cached.id, username: cached.username };
      const { id, username } = await clientFor(conn, repository).me();
      upsertMeta(db, key, JSON.stringify({ id, username, tokenHash }));
      return { id, username };
    },
  };
}

function mrPreview(deps: Pick<Deps, 'gitlab' | 'github'>): NonNullable<WatchServiceDeps['preview']> {
  return async (target) => {
    if (target.kind !== 'mr') return null;
    const mr = target.gitlab
      ? await deps.gitlab(target.gitlab.conn).mr(target.gitlab.apiProjectId, target.gitlab.iid)
      : target.github
        ? await deps.github(target.github.conn).mr(target.github.apiProjectId, target.github.number)
        : null;
    if (mr === null) return null;
    return { title: mr.title, state: mr.state, sourceBranch: mr.sourceBranch };
  };
}

export function createCore(config: Config, overrides: Partial<Deps> = {}, legacyConfig?: unknown): Core {
  const dataDir = new DataDir(config.dataDir);
  const db = openDb(dataDir.db);
  migrate(db);
  if (legacyConfig !== undefined) importLegacyRepositories(db, legacyConfig, config.configDir);
  const users = new UserService(db, () => (overrides.clock ?? systemClock).now());
  users.ensureBootstrapAdmin();
  const access = new AccessService(db);
  access.ensureBootstrap();
  access.ensureOwnership();
  const credentials = new CredentialService(db, path.join(dataDir.root, 'credentials.key'), () =>
    (overrides.clock ?? systemClock).now(),
  );
  const repositories = new RepositoryService(db, config);
  const configs = new ConfigResolver(db, config);
  const configFor = (repository: string | null) => configs.forRepository(repository);
  const secrets = configs.secretsFor(config);
  const secretsOf = (repository?: string) => configs.secretsFor(configs.forRepository(repository ?? null));

  const copilot = overrides.copilot ?? createCopilotLauncher(config, secrets);
  const launchers =
    overrides.launchers ??
    ({
      copilot,
      'claude-code': createClaudeCodeLauncher(config, secrets),
      codex: createCodexLauncher(config, secrets),
      opencode: createOpenCodeLauncher(config, secrets),
    } satisfies ProviderLaunchers);
  const deps: Deps = {
    clock: overrides.clock ?? systemClock,
    gitlab:
      overrides.gitlab ??
      ((conn, repository) => createGitLabClient(config.gitlab[conn]!.host, secretsOf(repository).gitlab[conn])),
    github:
      overrides.github ??
      ((conn, repository) => createGitHubClient(config.github[conn]!.host, secretsOf(repository).github[conn])),
    jira:
      overrides.jira ??
      ((conn, repository) => createJiraClient(config.jira.connections[conn]!, secretsOf(repository).jira[conn] ?? {})),
    copilot,
    launchers,
    notifier:
      overrides.notifier ??
      createTeamsNotifier({
        db,
        config,
        configFor,
        secretsFor: (effective) => configs.secretsFor(effective),
        launcher: copilot,
        dataDir,
        secrets,
      }),
  };
  const { clock, notifier } = deps;
  const onNeedsYou = (e: NeedsYouEvent) => notifier.notifyNeedsYou(e);

  const prechecks = createPrechecks({
    config,
    secrets,
    configFor,
    secretsFor: (effective) => configs.secretsFor(effective),
    repositories,
    gitlabClientFor: deps.gitlab,
    githubClientFor: deps.github,
    jiraClientFor: deps.jira,
    gitlabMeCache: metaMeCache(db, 'gitlab', deps.gitlab, secretsOf),
    githubMeCache: metaMeCache(db, 'github', deps.github, secretsOf),
  });
  const queue = new QueueService(db, clock, dataDir, config, repositories, {
    configFor,
    ticketTitle: async (conn, key) => (await deps.jira(conn).issue(key)).summary,
  });
  const agents = new AgentService(db);
  const executorDeps: RunExecutorDeps = {
    db,
    clock,
    config,
    configFor,
    secretsFor: (effective) => configs.secretsFor(effective),
    // Background Runs act with their owner's current permissions and credentials.
    authorize: (run) => {
      const owner = access.ownerOf('runs', run.id);
      if (owner === null) return 'The Run owner no longer exists';
      return access.canOnRepository(owner, 'write', run.repository)
        ? null
        : 'The Run owner no longer has write access to this Repository';
    },
    credentialEnv: (run) => credentials.env(access.ownerOf('runs', run.id)),
    repositories,
    dataDir,
    launchers,
    prechecks,
    agents,
    onNeedsYou,
  };

  return {
    config,
    db,
    dataDir,
    deps,
    executorDeps,
    watches: new WatchService({ db, clock, config, configFor, repositories, queue, dataDir, preview: mrPreview(deps) }),
    queue,
    scheduler: new Scheduler({ db, clock, config, configFor, dataDir, queue, repositories, prechecks, onNeedsYou }),
    executor: new RunExecutor(executorDeps),
    cleanup: new CleanupService({ db, clock, config, configFor, allConfigs: () => configs.all(), dataDir }),
    agents,
    projects: new ProjectService(db, repositories, () => clock.now()),
    users,
    credentials,
    access,
    configs,
    repositories,
    notifier,
    read: createReadModels({ db, config, configFor, clock, dataDir, repositories }),
    close() {
      if (db.open) db.close();
    },
  };
}

export function bootstrap(opts: { configPath?: string } = {}): Core {
  const file = path.resolve(opts.configPath ?? process.env.AUTOMATOR_CONFIG ?? 'automator.config.json');
  loadDotenv(path.dirname(file));
  return createCore(loadConfig({ path: file }), {}, readRawConfig(file));
}
