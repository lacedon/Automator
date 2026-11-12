'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
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

type Translate = (key: 'slotDefault' | 'deleteNone' | 'deleteAssigned', values?: Record<string, string>) => string;

function describeReference(ref: AgentAssignment, labels: Map<WorkflowType, string>, t: Translate): string {
  return `${ref.repository ?? t('slotDefault')} · ${labels.get(ref.workflowType) ?? ref.workflowType}`;
}

export function buildAgentDeletionMessage(
  name: string,
  references: AgentAssignment[],
  labels: Map<WorkflowType, string>,
  t: Translate,
): string {
  return references.length === 0
    ? t('deleteNone', { name })
    : t('deleteAssigned', { name, slots: references.map((r) => describeReference(r, labels, t)).join('; ') });
}

export function AgentForm({ agent, rows }: { agent?: Agent; rows?: number }) {
  const t = useTranslations('AgentSettings');
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
        <label htmlFor={`${idPrefix}-name`}>{t('name')}</label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          className={invalid === 'name' ? 'input-err' : undefined}
          defaultValue={echoed('name', agent?.name ?? '')}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-instructions`}>{t('instructions')}</label>
        <textarea
          id={`${idPrefix}-instructions`}
          name="instructions"
          rows={rows ?? (agent ? 5 : 4)}
          defaultValue={echoed('instructions', agent?.instructions ?? '')}
        />
        {agent && agent.instructions.trim() === '' && (
          <div className="field-hint muted">{t('emptyInstructionsHint')}</div>
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
          {t('allowAll')}
        </label>
        <div className="field-hint muted">{t('allowAllHint')}</div>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-allowed-tools`}>{t('allowedTools')}</label>
        <textarea
          id={`${idPrefix}-allowed-tools`}
          name="allowedTools"
          rows={3}
          placeholder="shell(git status)"
          defaultValue={echoed('allowedTools', agent?.allowedTools.join('\n') ?? '')}
        />
        <div className="field-hint muted">{t('allowedToolsHint')}</div>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-blocked-tools`}>{t('blockedTools')}</label>
        <textarea
          id={`${idPrefix}-blocked-tools`}
          name="blockedTools"
          rows={3}
          placeholder="shell(git push)"
          defaultValue={echoed('blockedTools', agent?.blockedTools.join('\n') ?? '')}
        />
        <div className="field-hint muted">{t('blockedToolsHint')}</div>
      </div>
      {agent && close && (
        <p>
          <Link href={`/settings/agents/${agent.id}`}>{t('openFullPage')}</Link>
        </p>
      )}
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {agent ? t('saveAgent') : t('createAgent')}
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
  const t = useTranslations('AgentSettings');
  const references = assignments.filter((a) => a.agentId === agent.id);
  const served =
    references.length === 0
      ? t('notAssigned')
      : t('serves', { slots: references.map((r) => describeReference(r, labels, t)).join('; ') });
  const prepare = async (): Promise<ActionResult<string>> => {
    const result = await agentDeletionImpact(agent.id);
    if (!result.ok) return result;
    if (result.value === undefined) return { ok: true };
    return { ok: true, value: buildAgentDeletionMessage(agent.name, result.value, labels, t) };
  };
  return (
    <SettingsTableRow
      name={agent.name}
      actions={
        <>
          <SettingsDialog title={t('editTitle', { name: agent.name })} wide>
            <AgentForm agent={agent} rows={16} />
          </SettingsDialog>
          <ConfirmDialog
            danger
            label={t('deleteAgent')}
            message={buildAgentDeletionMessage(agent.name, references, labels, t)}
            confirmLabel={t('deleteAgent')}
            dismissLabel={t('keepAgent')}
            action={deleteAgent.bind(null, agent.id)}
            prepare={prepare}
          />
        </>
      }
    >
      <p className="muted field-hint">{served}</p>
      <p className="agent-preview">{agent.instructions.trim() === '' ? t('noInstructions') : agent.instructions}</p>
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
  const t = useTranslations('AgentSettings');
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
        {repository !== null && <option value={INHERIT}>{t('inheritDefault')}</option>}
        <option value={BLOCKED} disabled>
          {repository === null && slot === undefined ? t('notSetBlocked') : t('noAgentBlocked')}
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
  const t = useTranslations('AgentSettings');
  if (status.length === 0) return null;
  return (
    <p className="field-hint" role="status">
      {t('setupNeedsAttention', { status: status.join('; ') })}
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
  const t = useTranslations('AgentSettings');
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
        <label htmlFor={`template-${workflowType}`}>{t('operationTemplate')}</label>
        <textarea
          id={`template-${workflowType}`}
          name="instructions"
          rows={4}
          defaultValue={echoed('instructions', template?.instructions ?? '')}
        />
        <div className="field-hint muted">{t('templateHint')}</div>
      </div>
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {t('saveTemplate')}
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
  const t = useTranslations('AgentSettings');
  const tError = useTranslations('ErrorBox');
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
      <p className="muted">{t('assignmentsSaveNote')}</p>
      {assignmentError !== null && (
        <ErrorBox error={assignmentError} unknownRepositoryOutcome={tError('nothingChanged')} />
      )}
      <AssignmentSelect
        id={`default-${type}`}
        label={t('defaultAgent')}
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
  const t = useTranslations('AgentSettings');
  const labels = new Map(workflows.map((workflow) => [workflow.type, workflow.label]));
  return (
    <div className="agent-settings">
      <div className="settings-toolbar">
        <SettingsDialog title={t('newAgent')} trigger={t('newAgent')} wide>
          <AgentForm rows={12} />
        </SettingsDialog>
      </div>
      <h2 className="section-h">{t('agentsHeading')}</h2>
      <p className="muted">{t('agentsIntro')}</p>
      {agents.length === 0 && <EmptyState>{t('noAgents')}</EmptyState>}
      {agents.length > 0 && (
        <SettingsTable label={t('agentsHeading')} headers={[t('agentCol'), t('detailsCol'), t('actionsCol')]}>
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} assignments={assignments} labels={labels} />
          ))}
        </SettingsTable>
      )}
      <h2 className="section-h">{t('assignmentsHeading')}</h2>
      <p className="muted">{t('assignmentsIntro')}</p>
      <SettingsTable label={t('workflows')} headers={[t('workflowCol'), t('detailsCol'), t('actionsCol')]}>
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
                <SettingsDialog title={t('workflowSettings', { label })} wide>
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
                {t('defaultSummary', { agent: defaultAgent?.name ?? t('noAgentBlocked') })} ·{' '}
                {templates.find((template) => template.workflowType === type)?.instructions.trim()
                  ? t('templateConfigured')
                  : t('noTemplate')}
              </span>
            </SettingsTableRow>
          );
        })}
      </SettingsTable>
    </div>
  );
}
