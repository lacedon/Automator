import { expect, test } from 'vitest';
import { defaultAgentId } from './defaultAgent';

const assignments = [
  { repository: null, workflowType: 'mr-watch' as const, agentId: 1 },
  { repository: 'pages', workflowType: 'mr-watch' as const, agentId: 2 },
  { repository: 'blocked', workflowType: 'mr-watch' as const, agentId: null },
];

test('prefers the Repository assignment, then the default, and treats a cleared assignment as none', () => {
  expect(defaultAgentId(assignments, 'pages', 'mr-watch')).toBe(2);
  expect(defaultAgentId(assignments, 'other', 'mr-watch')).toBe(1);
  expect(defaultAgentId(assignments, 'blocked', 'mr-watch')).toBeNull();
  expect(defaultAgentId(assignments, 'pages', 'jira-watch')).toBeNull();
});
