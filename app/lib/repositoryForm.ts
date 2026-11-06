import type { RepositoryInput } from '@core/index';

export function repositoryFromForm(data: FormData): RepositoryInput {
  const text = (key: string) => {
    const value = data.get(key);
    return typeof value === 'string' ? value : '';
  };
  return {
    name: text('name'),
    folder: text('folder'),
    gitlab: text('gitlab') || null,
    github: text('github') || null,
    jira: text('jira') || null,
    validate: text('validate')
      .split(/\r?\n/)
      .map((command) => command.trim())
      .filter(Boolean),
  };
}
