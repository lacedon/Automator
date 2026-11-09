import { providerOptions } from '../config/providers';
import type { AgentAssignment, InitialReview, ProjectScope, ProviderName, WorkflowType } from '../domain/types';
import type { ReadDeps } from './deps';
import { scopeFilter } from './scope';

export type FormOptions = {
  repositories: { name: string; folder: string; host: string | null; project: string | null }[];
  provider: ProviderName;
  models: string[];
  defaultModel: string;
  intervals: { mr: number; default: number };
  initialReview: InitialReview;
  jiraEnabled: boolean;
  agents: { id: number; name: string }[];
  agentAssignments: AgentAssignment[];
};

export function formOptions(deps: ReadDeps, scope: ProjectScope = null): FormOptions {
  const { config, db, repositories } = deps;
  const inScope = scopeFilter(deps, scope);
  const { runs } = config;
  const options = providerOptions(config, config.provider);
  const projectOf = new Map(
    (
      db
        .prepare('SELECT pr.repository, p.name FROM project_repositories pr JOIN projects p ON p.id = pr.project_id')
        .all() as { repository: string; name: string }[]
    ).map((r) => [r.repository, r.name]),
  );
  return {
    repositories: repositories
      .list()
      .filter((repo) => inScope(repo.name))
      .map((repo) => ({
        name: repo.name,
        folder: repo.folder,
        project: projectOf.get(repo.name) ?? null,
        host:
          (repo.gitlab && config.gitlab[repo.gitlab]?.host) ||
          (repo.github && config.github[repo.github]?.host) ||
          null,
      })),
    provider: config.provider,
    models: [...new Set([options.defaultModel, ...options.models])],
    defaultModel: options.defaultModel,
    intervals: { ...config.schedule.intervals },
    initialReview: runs.initialReview,
    jiraEnabled: config.jira.enabled,
    agents: (db.prepare('SELECT id, name FROM agents ORDER BY id').all() as { id: number; name: string }[]).map(
      ({ id, name }) => ({ id, name }),
    ),
    agentAssignments: (
      db.prepare('SELECT repository, workflow_type, agent_id FROM agent_assignments').all() as {
        repository: string | null;
        workflow_type: WorkflowType;
        agent_id: number | null;
      }[]
    ).map((r) => ({ repository: r.repository, workflowType: r.workflow_type, agentId: r.agent_id })),
  };
}
