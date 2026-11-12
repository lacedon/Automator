import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { createCore, type Core } from '@core/index';
import en from '../../messages/en.json';
import { AgentSettings } from '../components/AgentSettings';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('../lib/guard', async () => (await import('../lib/guard.mock')).allowAll);
vi.mock('next/cache', () => ({ revalidatePath }));

const { saveAgent, assignAgent, clearRepositoryAgent, saveTemplate, agentDeletionImpact, deleteAgent } =
  await import('./agents');

let core: Core;

beforeEach(() => {
  const config = testConfig();
  core = createCore(
    config,
    { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } },
    { repositories: config.repositories },
  );
  holder.core = core;
  revalidatePath.mockClear();
});

afterEach(() => core.close());

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

test('saveAgent creates an Agent and echoes nothing on success', async () => {
  const result = await saveAgent(null, form({ name: ' Reviewer ', instructions: 'Be strict.' }));
  expect(result).toBeNull();
  expect(core.agents.listAgents().at(-1)).toMatchObject({ name: 'Reviewer', instructions: 'Be strict.' });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('saveAgent updates an existing Agent and reports a missing one', async () => {
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  expect(await saveAgent(null, form({ id: String(agent.id), name: 'B', instructions: 'y' }))).toBeNull();
  expect(core.agents.getAgent(agent.id)).toMatchObject({ name: 'B', instructions: 'y' });

  const missing = await saveAgent(null, form({ id: '9999', name: 'B', instructions: 'y' }));
  expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('saveAgent rejects a blank name and keeps the submitted values', async () => {
  const before = core.agents.listAgents().length;
  const result = await saveAgent(null, form({ name: '  ', instructions: 'keep me' }));
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'name' },
    values: { instructions: 'keep me' },
  });
  expect(core.agents.listAgents()).toHaveLength(before);
});

test('assignAgent sets default and Repository assignments', async () => {
  core.config.repositories = {};
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  expect(await assignAgent(null, 'mr-watch', agent.id)).toEqual({ ok: true });
  expect(await assignAgent('pages', 'jira-watch', agent.id)).toEqual({ ok: true });
  expect(core.agents.resolve('api', 'mr-watch').agent?.id).toBe(agent.id);
  expect(core.agents.resolve('pages', 'jira-watch')).toMatchObject({ assignmentScope: 'repository' });
});

test('assignAgent validates Workflow, Repository and Agent', async () => {
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  const before = core.agents.listAssignments();
  expect(await assignAgent(null, 'bogus', agent.id)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'workflowType' },
  });
  expect(await assignAgent('nope', 'mr-watch', agent.id)).toMatchObject({
    ok: false,
    error: { code: 'UNKNOWN_REPOSITORY', name: 'nope' },
  });
  expect(await assignAgent('pages', 'mr-watch', 9999)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(core.agents.listAssignments()).toEqual(before);
});

test('Agent Settings shows actionable status for an invalid persisted Repository', () => {
  const missingFolder = `${core.config.configDir}/missing-agent-repository`;
  core.db
    .prepare(
      `INSERT INTO repositories (name, folder, gitlab, github, jira, validate_json)
       VALUES ('broken', ?, 'corp', NULL, 'missing-jira', '[]')`,
    )
    .run(missingFolder);
  const status = core.repositories.status('broken');
  const markup = renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- the provider's props type requires children
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: en,
      children: createElement(AgentSettings, {
        agents: [],
        assignments: [],
        templates: [],
        repositories: [{ name: 'broken', status }],
        workflows: [{ type: 'mr-watch', label: 'MR Watch' }],
      }),
    }),
  );

  expect(markup).toContain('Repository setup needs attention');
  expect(markup).toContain(`Folder does not exist: ${missingFolder}`);
  expect(markup).toContain('Unknown Jira connection &quot;missing-jira&quot;');
  expect(markup).not.toContain('GITLAB_TOKEN');
});

test('clearRepositoryAgent removes only the Repository override', async () => {
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  core.agents.assign('pages', 'mr-watch', agent.id);
  expect(await clearRepositoryAgent('pages', 'mr-watch')).toEqual({ ok: true });
  expect(core.agents.resolve('pages', 'mr-watch').assignmentScope).toBe('default');
  expect(await clearRepositoryAgent('nope', 'mr-watch')).toMatchObject({
    ok: false,
    error: { code: 'UNKNOWN_REPOSITORY' },
  });
});

test('saveTemplate stores, replaces and clears one template per Workflow', async () => {
  expect(await saveTemplate(null, form({ workflowType: 'mr-watch', instructions: ' Shared. ' }))).toBeNull();
  expect(core.agents.getTemplate('mr-watch')?.instructions).toBe(' Shared. ');
  expect(await saveTemplate(null, form({ workflowType: 'mr-watch', instructions: '   ' }))).toBeNull();
  expect(core.agents.getTemplate('mr-watch')).toBeNull();
  expect(await saveTemplate(null, form({ workflowType: 'bogus', instructions: 'x' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'workflowType' },
  });
});

test('agentDeletionImpact lists every affected reference without deleting', async () => {
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  core.agents.assign(null, 'mr-watch', agent.id);
  core.agents.assign('pages', 'jira-watch', agent.id);
  core.agents.assign('api', 'free-adhoc', agent.id);

  const result = await agentDeletionImpact(agent.id);
  expect(result).toMatchObject({ ok: true });
  expect(result.ok && result.value).toEqual([
    { repository: null, workflowType: 'mr-watch', agentId: agent.id },
    { repository: 'api', workflowType: 'free-adhoc', agentId: agent.id },
    { repository: 'pages', workflowType: 'jira-watch', agentId: agent.id },
  ]);
  expect(core.agents.getAgent(agent.id)).not.toBeNull();
  expect(await agentDeletionImpact(9999)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('agentDeletionImpact includes references added after an earlier lookup', async () => {
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  expect(await agentDeletionImpact(agent.id)).toMatchObject({ ok: true, value: [] });

  core.agents.assign('pages', 'jira-watch', agent.id);

  expect(await agentDeletionImpact(agent.id)).toMatchObject({
    ok: true,
    value: [{ repository: 'pages', workflowType: 'jira-watch', agentId: agent.id }],
  });
});

test('deleteAgent clears references to blocking null slots and returns them', async () => {
  const agent = core.agents.createAgent({ name: 'A', instructions: 'x' });
  core.agents.assign('pages', 'mr-watch', agent.id);
  const result = await deleteAgent(agent.id);
  expect(result.ok && result.value).toEqual([{ repository: 'pages', workflowType: 'mr-watch', agentId: agent.id }]);
  expect(core.agents.getAgent(agent.id)).toBeNull();
  expect(core.agents.resolve('pages', 'mr-watch')).toMatchObject({ agent: null, assignmentScope: 'blocked' });
  expect(await deleteAgent(agent.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await deleteAgent(-1)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
