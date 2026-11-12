import { getTranslations } from 'next-intl/server';
import type { WorkflowType } from '@core/index';
import { AgentSettings } from '../../components/AgentSettings';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

const WORKFLOW_LABEL_KEYS = {
  'mr-watch': 'wfMr',
  'jira-watch': 'wfJira',
  'free-watch': 'wfFree',
  'ticket-adhoc': 'wfTicketAdhoc',
  'free-adhoc': 'wfFreeAdhoc',
} as const satisfies Record<WorkflowType, string>;

export default async function AgentSettingsPage() {
  const core = getCore();
  const t = await getTranslations('AgentSettings');
  const WORKFLOWS = (Object.keys(WORKFLOW_LABEL_KEYS) as WorkflowType[]).map((type) => ({
    type,
    label: t(WORKFLOW_LABEL_KEYS[type]),
  }));
  const templates = WORKFLOWS.flatMap(({ type }) => core.agents.getTemplate(type) ?? []);
  return (
    <>
      <h1 className="page-title">{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
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
