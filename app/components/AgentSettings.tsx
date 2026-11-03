'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { Agent, AgentAssignment, OperationTemplate, WorkflowType } from '@core/index';
import {
  assignAgent,
  agentDeletionImpact,
  clearRepositoryAgent,
  deleteAgent,
  saveAgent,
  saveTemplate,
  type AgentFormValues,
  type TemplateFormValues,
} from '../actions/agents';
import type { ActionResult } from '../actions/types';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { ErrorBox, errorMessage } from './ErrorBox';

type Props = {
  agents: Agent[];
  assignments: AgentAssignment[];
  templates: OperationTemplate[];
  repositories: string[];
  workflows: { type: WorkflowType; label: string }[];
};

const BLOCKED = '__blocked';
const INHERIT = '';

function describeReference(ref: AgentAssignment, labels: Map<WorkflowType, string>): string {
  return `${ref.repository ?? 'Default'} · ${labels.get(ref.workflowType) ?? ref.workflowType}`;
}

export function buildAgentDeletionMessage(
  name: string,
  references: AgentAssignment[],
  labels: Map<WorkflowType, string>,
): string {
  return references.length === 0
    ? `Delete Agent "${name}"? It is not assigned anywhere.`
    : `Delete Agent "${name}"? It is assigned to: ${references
        .map((r) => describeReference(r, labels))
        .join('; ')}. Each of these slots will have no Agent and block Runs until you assign another one.`;
}

function AgentForm({ agent }: { agent?: Agent }) {
  const [state, formAction, pending] = useActionState(saveAgent, null);
  const idPrefix = `agent-${agent?.id ?? 'new'}`;
  const invalid = state?.error.code === 'INVALID_INPUT' ? state.error.field : null;
  const echoed = (field: keyof AgentFormValues, fallback: string) => state?.values[field] ?? fallback;

  // React resets a form after its action runs; submitting manually keeps entered values after a failed save.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };

  return (
    <form onSubmit={submit}>
      {state !== null && <ErrorBox error={state.error} />}
      {agent && <input type="hidden" name="id" value={agent.id} />}
      <div className="field">
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          className={invalid === 'name' ? 'input-err' : undefined}
          defaultValue={echoed('name', agent?.name ?? '')}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-instructions`}>Instructions</label>
        <textarea
          id={`${idPrefix}-instructions`}
          name="instructions"
          rows={agent ? 5 : 4}
          defaultValue={echoed('instructions', agent?.instructions ?? '')}
        />
        {agent && agent.instructions.trim() === '' && (
          <div className="field-hint muted">Empty: Runs that resolve to this Agent are blocked.</div>
        )}
      </div>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {agent ? 'Save Agent' : 'Create Agent'}
      </button>
    </form>
  );
}

function AgentCard({
  agent,
  assignments,
  labels,
}: {
  agent: Agent;
  assignments: AgentAssignment[];
  labels: Map<WorkflowType, string>;
}) {
  const references = assignments.filter((a) => a.agentId === agent.id);
  const served =
    references.length === 0
      ? 'Not assigned anywhere.'
      : `Serves ${references.map((r) => describeReference(r, labels)).join('; ')}.`;
  const prepare = async (): Promise<ActionResult<string>> => {
    const result = await agentDeletionImpact(agent.id);
    if (!result.ok) return result;
    if (result.value === undefined) return { ok: true };
    return { ok: true, value: buildAgentDeletionMessage(agent.name, result.value, labels) };
  };
  return (
    <div className="card">
      <div className="card-title">{agent.name}</div>
      <p className="muted field-hint">{served}</p>
      <AgentForm agent={agent} />
      <div className="field">
        <ConfirmDialog
          danger
          label="Delete Agent"
          message={buildAgentDeletionMessage(agent.name, references, labels)}
          confirmLabel="Delete Agent"
          dismissLabel="Keep Agent"
          action={deleteAgent.bind(null, agent.id)}
          prepare={prepare}
        />
      </div>
    </div>
  );
}

function AssignmentSelect({
  id,
  label,
  repository,
  workflowType,
  slot,
  agents,
  onResult,
}: {
  id: string;
  label: string;
  repository: string | null;
  workflowType: WorkflowType;
  slot: AgentAssignment | undefined;
  agents: Agent[];
  onResult: (result: ActionResult | string) => void;
}) {
  const [pending, setPending] = useState(false);
  const value =
    slot === undefined
      ? repository === null
        ? BLOCKED
        : INHERIT
      : slot.agentId === null
        ? BLOCKED
        : String(slot.agentId);

  const change = (next: string) => {
    setPending(true);
    startTransition(async () => {
      try {
        onResult(
          next === INHERIT
            ? await clearRepositoryAgent(repository!, workflowType)
            : await assignAgent(repository, workflowType, Number(next)),
        );
      } catch (e) {
        onResult(errorMessage(e));
      } finally {
        setPending(false);
      }
    });
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={pending} onChange={(e) => change(e.target.value)}>
        {repository !== null && <option value={INHERIT}>Inherit default</option>}
        <option value={BLOCKED} disabled>
          {repository === null && slot === undefined ? 'Not set: Runs blocked' : 'No Agent: Runs blocked'}
        </option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function TemplateForm({
  workflowType,
  template,
}: {
  workflowType: WorkflowType;
  template: OperationTemplate | undefined;
}) {
  const [state, formAction, pending] = useActionState(saveTemplate, null);
  const echoed = (field: keyof TemplateFormValues, fallback: string) => state?.values[field] ?? fallback;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };
  return (
    <form onSubmit={submit}>
      {state !== null && <ErrorBox error={state.error} />}
      <input type="hidden" name="workflowType" value={workflowType} />
      <div className="field">
        <label htmlFor={`template-${workflowType}`}>Operation template</label>
        <textarea
          id={`template-${workflowType}`}
          name="instructions"
          rows={4}
          defaultValue={echoed('instructions', template?.instructions ?? '')}
        />
        <div className="field-hint muted">
          Shared by every Repository and Agent for this Workflow. Blank means none.
        </div>
      </div>
      <button type="submit" className="btn btn-secondary" disabled={pending}>
        Save template
      </button>
    </form>
  );
}

export function AgentSettings({ agents, assignments, templates, repositories, workflows }: Props) {
  const [assignmentError, setAssignmentError] = useState<Extract<ActionResult, { ok: false }>['error'] | string | null>(
    null,
  );
  const labels = new Map(workflows.map((w) => [w.type, w.label]));
  const slot = (repository: string | null, type: WorkflowType) =>
    assignments.find((a) => a.repository === repository && a.workflowType === type);

  const onResult = (result: ActionResult | string) => {
    if (typeof result === 'string') setAssignmentError(result);
    else setAssignmentError(result.ok ? null : result.error);
  };

  return (
    <div className="agent-settings">
      <h2 className="section-h">Assignments and templates</h2>
      <p className="muted">
        Each Workflow uses its Repository Agent if one is set, otherwise the default. A slot with no Agent, or an Agent
        with empty instructions, blocks Runs before Copilot starts.
      </p>
      {assignmentError !== null && <ErrorBox error={assignmentError} unknownRepositoryOutcome="Nothing was changed." />}
      <div className="agent-grid agent-grid--assignments">
        {workflows.map(({ type, label }) => (
          <div className="card" key={type}>
            <div className="card-title">{label}</div>
            <AssignmentSelect
              id={`default-${type}`}
              label="Default Agent"
              repository={null}
              workflowType={type}
              slot={slot(null, type)}
              agents={agents}
              onResult={onResult}
            />
            {repositories.map((repository) => (
              <AssignmentSelect
                key={repository}
                id={`${repository}-${type}`}
                label={repository}
                repository={repository}
                workflowType={type}
                slot={slot(repository, type)}
                agents={agents}
                onResult={onResult}
              />
            ))}
            <TemplateForm workflowType={type} template={templates.find((t) => t.workflowType === type)} />
          </div>
        ))}
      </div>

      <h2 className="section-h">Agents</h2>
      <p className="muted">Agents are instruction-only profiles and can be assigned to any Workflow.</p>
      {agents.length === 0 && <EmptyState>No Agents yet.</EmptyState>}
      <div className="agent-grid agent-grid--agents">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} assignments={assignments} labels={labels} />
        ))}
      </div>
      <div className="card agent-new-card">
        <div className="card-title">New Agent</div>
        <AgentForm key={agents.length} />
      </div>
    </div>
  );
}
