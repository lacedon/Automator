import path from 'node:path';
import type { InitialReview, WatchKind } from '../domain/types';
import type { ReadDeps } from './deps';

export type FormOptions = {
  repositories: { name: string; folder: string; host: string | null }[];
  models: string[];
  defaultModel: string;
  intervals: { mr: number; default: number };
  initialReview: InitialReview;
  jiraEnabled: boolean;
  defaultPromptFiles: Record<WatchKind, string | null>;
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
    // Free-form Watches have no default prompt; their instructions are the whole task.
    defaultPromptFiles: {
      mr: path.join(config.prompts.dir, 'mr.md'),
      jira: path.join(config.prompts.dir, 'jira.md'),
      free: null,
    },
  };
}
