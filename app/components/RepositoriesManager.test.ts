import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { Repository } from '@core/index';
import { RepositoriesManager } from './RepositoriesManager';

const coreHolder = vi.hoisted(() => ({ core: null as unknown }));
vi.mock('../lib/core', () => ({ getCore: () => coreHolder.core }));
vi.mock('../actions/repositories', () => ({
  createRepository: async () => null,
  deleteRepository: async () => ({ ok: true }),
  updateRepository: async () => ({ ok: true }),
}));
import RepositorySettingsPage from '../settings/repositories/page';

test('shows invalid imported Repository diagnostics and explains deletion safety', () => {
  const repository: Repository = {
    name: 'legacy',
    folder: '/missing/legacy',
    gitlab: 'retired',
    github: null,
    jira: null,
    validate: [],
    promptAddition: '',
  };
  const markup = renderToStaticMarkup(
    createElement(RepositoriesManager, {
      repositories: [
        {
          repository,
          status: ['Folder does not exist: /missing/legacy', 'Unknown GitLab connection "retired"'],
          projectName: 'Legacy project',
        },
      ],
      connections: { gitlab: ['corp'], github: ['public'], jira: ['work'] },
    }),
  );
  expect(markup).toContain('Folder does not exist: /missing/legacy');
  expect(markup).toContain('name="folder" value="/missing/legacy"');
  expect(markup).toContain('Unknown GitLab connection');
  expect(markup).toMatch(/local files are never deleted/i);
  expect(markup).toContain('Repository with Automations cannot be deleted');
  expect(markup).toContain('retired');
  expect(markup).toContain('Legacy project');
  expect(markup).toContain('href="/settings/projects"');
  expect(markup).not.toContain('<option value="retired">');
});

test('settings page passes connection names only, not credential environment bindings', () => {
  const repository: Repository = {
    name: 'legacy',
    folder: '/missing/legacy',
    gitlab: 'corp',
    github: null,
    jira: 'work',
    validate: [],
    promptAddition: '',
  };
  coreHolder.core = {
    config: {
      gitlab: { corp: { host: 'https://gitlab.example', tokenEnv: 'GITLAB_SECRET_BINDING' } },
      github: { public: { host: 'github.com', tokenEnv: 'GITHUB_SECRET_BINDING' } },
      jira: { connections: { work: { baseUrl: 'https://jira.example', emailEnv: 'JIRA_EMAIL_BINDING' } } },
    },
    repositories: {
      list: () => [repository],
      status: () => ['Folder does not exist: /missing/legacy'],
    },
    projects: { list: () => [] },
  };
  const markup = renderToStaticMarkup(createElement(RepositorySettingsPage));
  expect(markup).toContain('corp');
  expect(markup).toContain('public');
  expect(markup).toContain('work');
  expect(markup).not.toMatch(/SECRET_BINDING|EMAIL_BINDING|tokenEnv|emailEnv/);
});

test('offers only connection names and never environment bindings', () => {
  const markup = renderToStaticMarkup(
    createElement(RepositoriesManager, {
      repositories: [],
      connections: { gitlab: ['corp'], github: ['public'], jira: ['work'] },
    }),
  );
  expect(markup).toContain('corp');
  expect(markup).toContain('public');
  expect(markup).toContain('work');
  expect(markup).not.toMatch(/tokenEnv|emailEnv|SECRET_TOKEN/i);
});
