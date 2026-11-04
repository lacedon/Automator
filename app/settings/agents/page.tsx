import type { WorkflowType } from '@core/index';
import { AgentSettings } from '../../components/AgentSettings';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

const WORKFLOWS: { type: WorkflowType; label: string }[] = [
  { type: 'mr-watch', label: 'MR Watch' },
  { type: 'jira-watch', label: 'Jira Watch' },
  { type: 'free-watch', label: 'Free Watch' },
  { type: 'ticket-adhoc', label: 'Ticket Ad-hoc' },
  { type: 'free-adhoc', label: 'Free-form Ad-hoc' },
];

export default function AgentSettingsPage() {
  const core = getCore();
  const templates = WORKFLOWS.flatMap(({ type }) => core.agents.getTemplate(type) ?? []);
  return (
    <>
      <h1 className="page-title">Agents</h1>
      <p className="muted">How is prompt behavior configured for each Repository and Workflow?</p>
      <AgentSettings
        agents={core.agents.listAgents()}
        assignments={core.agents.listAssignments()}
        templates={templates}
        repositories={core.repositories.list().map((repository) => ({
          name: repository.name,
          status: core.repositories.status(repository.name),
        }))}
        workflows={WORKFLOWS}
      />
    </>
  );
}
