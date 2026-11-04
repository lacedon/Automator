import type { InitialReview } from '../domain/types';
import type { ReadDeps } from './deps';

export type FormOptions = {
  repositories: { name: string; folder: string; host: string | null; project: string | null }[];
  models: string[];
  defaultModel: string;
  intervals: { mr: number; default: number };
  initialReview: InitialReview;
  jiraEnabled: boolean;
};

export function formOptions({ config, db, repositories }: ReadDeps): FormOptions {
  const { runs } = config;
  const projectOf = new Map(
    (
      db
        .prepare('SELECT pr.repository, p.name FROM project_repositories pr JOIN projects p ON p.id = pr.project_id')
        .all() as { repository: string; name: string }[]
    ).map((r) => [r.repository, r.name]),
  );
  return {
    repositories: repositories.list().map((repo) => ({
      name: repo.name,
      folder: repo.folder,
      project: projectOf.get(repo.name) ?? null,
      host:
        (repo.gitlab && config.gitlab[repo.gitlab]?.host) || (repo.github && config.github[repo.github]?.host) || null,
    })),
    models: [...new Set([runs.defaultModel, ...runs.models])],
    defaultModel: runs.defaultModel,
    intervals: { ...config.schedule.intervals },
    initialReview: runs.initialReview,
    jiraEnabled: config.jira.enabled,
  };
}
