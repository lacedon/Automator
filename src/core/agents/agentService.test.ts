import { afterEach, describe, expect, test } from 'vitest';
import type { WorkflowType } from '../domain/types';
import { tempDb } from '../../../test/helpers/db';
import { AgentService } from './agentService';

const cleanups: (() => void)[] = [];

function setup() {
  const { db, cleanup } = tempDb();
  cleanups.push(cleanup);
  return { db, agents: new AgentService(db) };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('AgentService', () => {
  test('stores per-Agent tool permissions, defaulting to allow all', () => {
    const { agents } = setup();
    const agent = agents.createAgent({ name: 'Reviewer', instructions: 'Review carefully.' });
    expect(agent).toMatchObject({ allowAllTools: true, allowedTools: [], blockedTools: [] });
    expect(
      agents.updateAgent(agent.id, {
        name: 'Reviewer',
        instructions: 'Review carefully.',
        allowAllTools: false,
        allowedTools: ['shell(git status)'],
        blockedTools: ['shell(git push)'],
      }),
    ).toMatchObject({ allowAllTools: false, allowedTools: ['shell(git status)'], blockedTools: ['shell(git push)'] });
  });

  test('creates, lists, reads, and updates Agent profiles', () => {
    const { agents } = setup();
    const agent = agents.createAgent({ name: 'Reviewer', instructions: 'Review carefully.' });
    expect(agents.getAgent(agent.id)).toEqual(agent);
    expect(agents.listAgents()).toContainEqual(agent);
    expect(agents.updateAgent(agent.id, { name: 'Strict reviewer', instructions: 'Review thoroughly.' })).toMatchObject(
      { id: agent.id, name: 'Strict reviewer', instructions: 'Review thoroughly.' },
    );
    expect(agents.updateAgent(-1, { name: 'Missing', instructions: '' })).toBeNull();
  });

  test('lists every assignment that references an Agent', () => {
    const { agents } = setup();
    const agent = agents.listAgents()[0]!;
    const workflowType = 'mr-watch' satisfies WorkflowType;
    agents.assign(null, workflowType, agent.id);
    agents.assign('pages', workflowType, agent.id);

    expect(agents.assignmentReferences(agent.id)).toEqual([
      { repository: null, workflowType, agentId: agent.id },
      { repository: 'pages', workflowType, agentId: agent.id },
    ]);
  });

  test('resolves a repository assignment before the installation default', () => {
    const { agents } = setup();
    const workflowType = 'mr-watch' satisfies WorkflowType;
    const defaultAgent = agents.resolve('pages', workflowType).agent!;
    const repositoryAgent = agents.createAgent({ name: 'Pages reviewer', instructions: 'Pages only.' });
    agents.assign('pages', workflowType, repositoryAgent.id);

    expect(agents.resolve('pages', workflowType)).toMatchObject({
      agent: repositoryAgent,
      assignmentScope: 'repository',
    });
    expect(agents.resolve('other', workflowType)).toMatchObject({
      agent: defaultAgent,
      assignmentScope: 'default',
    });
  });

  test('treats a repository assignment with a null Agent as blocked instead of falling back', () => {
    const { agents, db } = setup();
    const workflowType = 'mr-watch' satisfies WorkflowType;
    db.prepare('INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, NULL)').run(
      'pages',
      workflowType,
    );

    expect(agents.resolve('pages', workflowType)).toMatchObject({ agent: null, assignmentScope: 'blocked' });
  });

  test('clears a repository override to restore installation-default fallback', () => {
    const { agents } = setup();
    const workflowType = 'mr-watch' satisfies WorkflowType;
    const defaultAgent = agents.resolve('pages', workflowType).agent!;
    const repositoryAgent = agents.createAgent({ name: 'Pages reviewer', instructions: 'Pages only.' });
    agents.assign('pages', workflowType, repositoryAgent.id);
    agents.clearRepositoryOverride('pages', workflowType);

    expect(agents.resolve('pages', workflowType)).toMatchObject({
      agent: defaultAgent,
      assignmentScope: 'default',
    });
  });

  test('deletes an Agent while preserving all referencing assignment slots as blocked', () => {
    const { agents } = setup();
    const workflowType = 'mr-watch' satisfies WorkflowType;
    const agent = agents
      .listAgents()
      .find((candidate) =>
        agents
          .assignmentReferences(candidate.id)
          .some((reference) => reference.repository === null && reference.workflowType === workflowType),
      )!;
    agents.assign('pages', workflowType, agent.id);

    expect(agents.deleteAgent(agent.id)).toEqual([
      { repository: null, workflowType, agentId: agent.id },
      { repository: 'pages', workflowType, agentId: agent.id },
    ]);
    expect(agents.resolve('pages', workflowType)).toMatchObject({ agent: null, assignmentScope: 'blocked' });
    expect(agents.resolve('other', workflowType)).toMatchObject({ agent: null, assignmentScope: 'blocked' });
    expect(agents.deleteAgent(agent.id)).toBeNull();
  });

  test('does not fall back to a non-empty default after deleting a repository Agent', () => {
    const { agents } = setup();
    const workflowType = 'mr-watch' satisfies WorkflowType;
    const defaultAgent = agents.resolve('pages', workflowType).agent!;
    agents.updateAgent(defaultAgent.id, { name: defaultAgent.name, instructions: 'Default instructions.' });
    const repositoryAgent = agents.createAgent({ name: 'Pages reviewer', instructions: 'Pages only.' });
    agents.assign('pages', workflowType, repositoryAgent.id);

    expect(agents.deleteAgent(repositoryAgent.id)).toEqual([
      { repository: 'pages', workflowType, agentId: repositoryAgent.id },
    ]);
    expect(agents.resolve('pages', workflowType)).toMatchObject({ agent: null, assignmentScope: 'blocked' });
    expect(agents.resolve('other', workflowType)).toMatchObject({
      agent: { id: defaultAgent.id, instructions: 'Default instructions.' },
      assignmentScope: 'default',
    });
  });

  test('keeps operation templates optional and supports clearing them', () => {
    const { agents } = setup();
    const workflowType = 'ticket-adhoc' satisfies WorkflowType;

    expect(agents.getTemplate(workflowType)).toBeNull();
    agents.setTemplate(workflowType, 'Shared template.');
    expect(agents.getTemplate(workflowType)).toEqual({ workflowType, instructions: 'Shared template.' });
    agents.setTemplate(workflowType, null);
    expect(agents.getTemplate(workflowType)).toBeNull();
    expect(agents.resolve('pages', workflowType).template).toBeNull();
  });

  test('imports legacy prompts once with repository-specific profiles', () => {
    const { agents } = setup();
    const prompts = {
      'mr-watch': 'Review merge requests.',
      'jira-watch': 'Review Jira tickets.',
      'ticket-adhoc': 'Handle a Ticket.',
    };

    expect(agents.importLegacyPrompts('pages', prompts)).toBe('imported');
    expect(agents.importLegacyPrompts('pages', prompts)).toBe('already-imported');
    expect(agents.listAssignments().filter((assignment) => assignment.repository === 'pages')).toEqual([
      { repository: 'pages', workflowType: 'mr-watch', agentId: expect.any(Number) },
      { repository: 'pages', workflowType: 'jira-watch', agentId: expect.any(Number) },
      { repository: 'pages', workflowType: 'ticket-adhoc', agentId: expect.any(Number) },
    ]);
    expect(
      agents
        .listAgents()
        .slice(-3)
        .map((agent) => agent.name),
    ).toEqual(['pages / MR Watch', 'pages / Jira Watch', 'pages / Ticket Ad-hoc']);
    expect(agents.resolve('pages', 'mr-watch').agent?.instructions).toBe('Review merge requests.');
  });

  test('rejects legacy prompt conflicts without partially creating profiles', () => {
    const { agents } = setup();
    const originalAgents = agents.listAgents();
    const workflowType = 'jira-watch' satisfies WorkflowType;
    agents.assign('pages', workflowType, agents.listAgents()[0]!.id);

    expect(() =>
      agents.importLegacyPrompts('pages', {
        'mr-watch': 'Review merge requests.',
        'jira-watch': 'Review Jira tickets.',
        'ticket-adhoc': 'Handle a Ticket.',
      }),
    ).toThrow(/pages.*jira-watch/i);
    expect(agents.listAgents()).toEqual(originalAgents);
    expect(agents.listAssignments().filter((assignment) => assignment.repository === 'pages')).toEqual([
      { repository: 'pages', workflowType, agentId: originalAgents[0]!.id },
    ]);
  });
});
