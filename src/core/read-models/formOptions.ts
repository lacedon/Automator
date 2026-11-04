import { providerOptions } from '../config/providers';
import type { InitialReview } from '../domain/types';
import type { ProviderName } from '../domain/types';
import type { ReadDeps } from './deps';

export type FormOptions = {
  repositories: { name: string; folder: string; host: string | null; project: string | null }[];
  provider: ProviderName;
  models: string[];
  defaultModel: string;
  intervals: { mr: number; default: number };
  initialReview: InitialReview;
  jiraEnabled: boolean;
};

export function formOptions({ config, db }: ReadDeps): FormOptions {
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
    repositories: Object.entries(config.repositories).map(([name, repo]) => ({
      name,
      folder: repo.folder,
      project: projectOf.get(name) ?? null,
      host:
        (repo.gitlab && config.gitlab[repo.gitlab]?.host) || (repo.github && config.github[repo.github]?.host) || null,
    })),
    provider: config.provider,
    models: [...new Set([options.defaultModel, ...options.models])],
    defaultModel: options.defaultModel,
    intervals: { ...config.schedule.intervals },
    initialReview: runs.initialReview,
    jiraEnabled: config.jira.enabled,
  };
}
