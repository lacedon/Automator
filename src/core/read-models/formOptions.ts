import type { InitialReview } from '../domain/types';
import type { ReadDeps } from './deps';

export type FormOptions = {
  repositories: { name: string; folder: string; host: string | null }[];
  models: string[];
  defaultModel: string;
  intervals: { mr: number; default: number };
  initialReview: InitialReview;
  jiraEnabled: boolean;
};

export function formOptions({ config }: ReadDeps): FormOptions {
  const { runs } = config;
  return {
    repositories: Object.entries(config.repositories).map(([name, repo]) => ({
      name,
      folder: repo.folder,
      host: config.gitlab[repo.gitlab]?.host ?? null,
    })),
    models: [...new Set([runs.defaultModel, ...runs.models])],
    defaultModel: runs.defaultModel,
    intervals: { ...config.schedule.intervals },
    initialReview: runs.initialReview,
    jiraEnabled: config.jira.enabled,
  };
}
