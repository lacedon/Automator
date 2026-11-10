'use client';

import Link from 'next/link';
import { startTransition, useActionState, useId, useState, type FormEvent } from 'react';
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
import { SettingsTable, SettingsTableRow } from './SettingsTable';
import { SettingsDialog, SettingsDialogActions, useSettingsDialog } from './SettingsDialog';

type Props = {
  agents: Agent[];
  assignments: AgentAssignment[];
  templates: OperationTemplate[];
  repositories: { name: string; status: string[] }[];
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

export function AgentForm({ agent, rows }: { agent?: Agent; rows?: number }) {
  const formId = useId();
  const close = useSettingsDialog();
  const [state, formAction, pending] = useActionState(
    async (previous: Parameters<typeof saveAgent>[0], data: FormData) => {
      const result = await saveAgent(previous, data);
      if (result === null) close?.();
      return result;
    },
    null,
  );
  useSettingsDialog(pending);
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
    <form id={formId} onSubmit={submit}>
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
          rows={rows ?? (agent ? 5 : 4)}
          defaultValue={echoed('instructions', agent?.instructions ?? '')}
        />
        {agent && agent.instructions.trim() === '' && (
          <div className="field-hint muted">Empty: Runs that resolve to this Agent are blocked.</div>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-allow-all`}>
          <input
            id={`${idPrefix}-allow-all`}
            type="checkbox"
            name="allowAllTools"
            defaultChecked={state === null ? (agent?.allowAllTools ?? true) : state.values.allowAllTools !== undefined}
          />{' '}
          Allow all tools
        </label>
        <div className="field-hint muted">
          Copilot only. When unchecked, only the allowed tools below are permitted.
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-allowed-tools`}>Allowed tools</label>
        <textarea
          id={`${idPrefix}-allowed-tools`}
          name="allowedTools"
          rows={3}
          placeholder="shell(git status)"
          defaultValue={echoed('allowedTools', agent?.allowedTools.join('\n') ?? '')}
        />
        <div className="field-hint muted">One Copilot tool pattern per line.</div>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-blocked-tools`}>Blocked tools</label>
        <textarea
          id={`${idPrefix}-blocked-tools`}
          name="blockedTools"
          rows={3}
          placeholder="shell(git push)"
          defaultValue={echoed('blockedTools', agent?.blockedTools.join('\n') ?? '')}
        />
        <div className="field-hint muted">
          One Copilot tool pattern per line, added to the global runs.denyTools, which always applies.
        </div>
      </div>
      {agent && close && (
        <p>
          <Link href={`/settings/agents/${agent.id}`}>Open full page</Link>
        </p>
      )}
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {agent ? 'Save Agent' : 'Create Agent'}
        </button>
      </SettingsDialogActions>
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
    <SettingsTableRow
      name={agent.name}
      actions={
        <>
          <SettingsDialog title={`Edit Agent: ${agent.name}`} wide>
            <AgentForm agent={agent} rows={16} />
          </SettingsDialog>
          <ConfirmDialog
            danger
            label="Delete Agent"
            message={buildAgentDeletionMessage(agent.name, references, labels)}
            confirmLabel="Delete Agent"
            dismissLabel="Keep Agent"
            action={deleteAgent.bind(null, agent.id)}
            prepare={prepare}
          />
        </>
      }
    >
      <p className="muted field-hint">{served}</p>
      <p className="agent-preview">{agent.instructions.trim() === '' ? 'No instructions yet.' : agent.instructions}</p>
    </SettingsTableRow>
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
  useSettingsDialog(pending);
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

function RepositoryStatus({ status }: { status: string[] }) {
  if (status.length === 0) return null;
  return (
    <p className="field-hint" role="status">
      Repository setup needs attention: {status.join('; ')}
    </p>
  );
}

function TemplateForm({
  workflowType,
  template,
}: {
  workflowType: WorkflowType;
  template: OperationTemplate | undefined;
}) {
  const formId = useId();
  const close = useSettingsDialog();
  const [state, formAction, pending] = useActionState(
    async (previous: Parameters<typeof saveTemplate>[0], data: FormData) => {
      const result = await saveTemplate(previous, data);
      if (result === null) close?.();
      return result;
    },
    null,
  );
  useSettingsDialog(pending);
  const echoed = (field: keyof TemplateFormValues, fallback: string) => state?.values[field] ?? fallback;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };
  return (
    <form id={formId} onSubmit={submit}>
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
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          Save template
        </button>
      </SettingsDialogActions>
    </form>
  );
}

function WorkflowEditor({
  type,
  agents,
  assignments,
  templates,
  repositories,
}: Omit<Props, 'workflows'> & { type: WorkflowType }) {
  const [assignmentError, setAssignmentError] = useState<Extract<ActionResult, { ok: false }>['error'] | string | null>(
    null,
  );
  const slot = (repository: string | null, type: WorkflowType) =>
    assignments.find((a) => a.repository === repository && a.workflowType === type);

  const onResult = (result: ActionResult | string) => {
    if (typeof result === 'string') setAssignmentError(result);
    else setAssignmentError(result.ok ? null : result.error);
  };

  return (
    <>
      <p className="muted">Assignment changes save immediately. Save the operation template separately.</p>
      {assignmentError !== null && <ErrorBox error={assignmentError} unknownRepositoryOutcome="Nothing was changed." />}
      <AssignmentSelect
        id={`default-${type}`}
        label="Default Agent"
        repository={null}
        workflowType={type}
        slot={slot(null, type)}
        agents={agents}
        onResult={onResult}
      />
      {repositories.map(({ name, status }) => (
        <div key={name}>
          <AssignmentSelect
            id={`${name}-${type}`}
            label={name}
            repository={name}
            workflowType={type}
            slot={slot(name, type)}
            agents={agents}
            onResult={onResult}
          />
          <RepositoryStatus status={status} />
        </div>
      ))}
      <TemplateForm workflowType={type} template={templates.find((t) => t.workflowType === type)} />
    </>
  );
}

export function AgentSettings({ agents, assignments, templates, repositories, workflows }: Props) {
  const labels = new Map(workflows.map((workflow) => [workflow.type, workflow.label]));
  return (
    <div className="agent-settings">
      <div className="settings-toolbar">
        <SettingsDialog title="New Agent" trigger="New Agent" wide>
          <AgentForm rows={12} />
        </SettingsDialog>
      </div>
      <h2 className="section-h">Agents</h2>
      <p className="muted">Agents are instruction-only profiles and can be assigned to any Workflow.</p>
      {agents.length === 0 && <EmptyState>No Agents yet.</EmptyState>}
      {agents.length > 0 && (
        <SettingsTable label="Agents" headers={['Agent', 'Details', 'Actions']}>
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} assignments={assignments} labels={labels} />
          ))}
        </SettingsTable>
      )}
      <h2 className="section-h">Assignments and templates</h2>
      <p className="muted">
        Each Workflow uses its Repository Agent if one is set, otherwise the default. A slot with no Agent, or an Agent
        with empty instructions, blocks Runs before Copilot starts.
      </p>
      <SettingsTable label="Workflows" headers={['Workflow', 'Details', 'Actions']}>
        {workflows.map(({ type, label }) => {
          const defaultSlot = assignments.find(
            (assignment) => assignment.repository === null && assignment.workflowType === type,
          );
          const defaultAgent = agents.find((agent) => agent.id === defaultSlot?.agentId);
          return (
            <SettingsTableRow
              key={type}
              name={label}
              actions={
                <SettingsDialog title={`${label} settings`} wide>
                  <WorkflowEditor
                    type={type}
                    agents={agents}
                    assignments={assignments}
                    templates={templates}
                    repositories={repositories}
                  />
                </SettingsDialog>
              }
            >
              <span className="muted">
                Default: {defaultAgent?.name ?? 'No Agent: Runs blocked'} ·{' '}
                {templates.find((template) => template.workflowType === type)?.instructions.trim()
                  ? 'Operation template configured'
                  : 'No operation template'}
              </span>
            </SettingsTableRow>
          );
        })}
      </SettingsTable>
    </div>
  );
}
