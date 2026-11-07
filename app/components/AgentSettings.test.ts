import { expect, test, vi } from 'vitest';
import type { AgentAssignment, WorkflowType } from '@core/index';
import { buildAgentDeletionMessage } from './AgentSettings';

vi.mock('../actions/agents', () => ({}));

test('buildAgentDeletionMessage lists every affected slot', () => {
  const references: AgentAssignment[] = [
    { repository: null, workflowType: 'mr-watch', agentId: 7 },
    { repository: 'api', workflowType: 'free-adhoc', agentId: 7 },
    { repository: 'pages', workflowType: 'jira-watch', agentId: 7 },
  ];
  const labels = new Map<WorkflowType, string>([
    ['mr-watch', 'Merge Request Automation'],
    ['jira-watch', 'Jira Automation'],
    ['free-adhoc', 'Free Adhoc'],
  ]);

  expect(buildAgentDeletionMessage('Reviewer', references, labels)).toBe(
    'Delete Agent "Reviewer"? It is assigned to: Default · Merge Request Automation; api · Free Adhoc; pages · Jira Automation. Each of these slots will have no Agent and block Runs until you assign another one.',
  );
});

test('buildAgentDeletionMessage preserves the unassigned wording', () => {
  expect(buildAgentDeletionMessage('Reviewer', [], new Map())).toBe(
    'Delete Agent "Reviewer"? It is not assigned anywhere.',
  );
});
