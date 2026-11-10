import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentForm } from '../../../components/AgentSettings';
import { getCore } from '../../../lib/core';

export const dynamic = 'force-dynamic';

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const core = getCore();
  const agent = Number.isInteger(id) ? core.agents.getAgent(id) : null;
  if (agent === null) notFound();
  const serves = core.agents.listAssignments().filter((a) => a.agentId === agent.id);
  return (
    <div className="agent-page">
      <Link href="/settings/agents" className="plain-link">
        ← Back to Settings
      </Link>
      <h1 className="page-title">{agent.name}</h1>
      <p className="muted">
        {serves.length === 0
          ? 'Not assigned anywhere.'
          : `Serves ${serves.map((a) => `${a.repository ?? 'Default'} · ${a.workflowType}`).join('; ')}.`}
      </p>
      <AgentForm key={`${agent.updatedAt}`} agent={agent} rows={24} />
    </div>
  );
}
