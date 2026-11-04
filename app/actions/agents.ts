'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AgentAssignment, AppError } from '@core/index';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult, FormResult } from './types';

const WORKFLOW_TYPES = ['mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc'] as const;

const idSchema = z.number().int().positive();
const workflowSchema = z.enum(WORKFLOW_TYPES);

function refresh(): void {
  revalidatePath('/', 'layout');
}

function unknownRepository(name: string): AppError | null {
  const repositories = getCore().repositories;
  const known = repositories.list().map((repository) => repository.name);
  return repositories.get(name) !== null ? null : { code: 'UNKNOWN_REPOSITORY', name, known, attemptFile: null };
}

const AGENT_FIELDS = ['id', 'name', 'instructions'] as const;
export type AgentFormValues = Partial<Record<(typeof AGENT_FIELDS)[number], string>>;

const agentSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  instructions: z.string(),
});

export async function saveAgent(
  _prev: FormResult<AgentFormValues>,
  formData: FormData,
): Promise<FormResult<AgentFormValues>> {
  const values: AgentFormValues = {};
  for (const field of AGENT_FIELDS) {
    const value = formData.get(field);
    if (typeof value === 'string') values[field] = value;
  }
  const input = parseInput(agentSchema, { ...values, id: values.id || undefined });
  if (!input.ok) return { ...input, values };
  const { id, name, instructions } = input.value;
  const agents = getCore().agents;
  if (id === undefined) {
    agents.createAgent({ name, instructions });
  } else if (agents.updateAgent(id, { name, instructions }) === null) {
    return { ok: false, error: { code: 'NOT_FOUND' }, values };
  }
  refresh();
  return null;
}

const assignSchema = z.object({
  repository: z.string().min(1).nullable(),
  workflowType: workflowSchema,
  agentId: idSchema,
});

export async function assignAgent(
  repository: string | null,
  workflowType: string,
  agentId: number,
): Promise<ActionResult> {
  const input = parseInput(assignSchema, { repository, workflowType, agentId });
  if (!input.ok) return input;
  const agents = getCore().agents;
  if (input.value.repository !== null) {
    const unknown = unknownRepository(input.value.repository);
    if (unknown) return { ok: false, error: unknown };
  }
  if (agents.getAgent(input.value.agentId) === null) return { ok: false, error: { code: 'NOT_FOUND' } };
  agents.assign(input.value.repository, input.value.workflowType, input.value.agentId);
  refresh();
  return { ok: true };
}

const clearSchema = z.object({ repository: z.string().min(1), workflowType: workflowSchema });

export async function clearRepositoryAgent(repository: string, workflowType: string): Promise<ActionResult> {
  const input = parseInput(clearSchema, { repository, workflowType });
  if (!input.ok) return input;
  const unknown = unknownRepository(input.value.repository);
  if (unknown) return { ok: false, error: unknown };
  getCore().agents.clearRepositoryOverride(input.value.repository, input.value.workflowType);
  refresh();
  return { ok: true };
}

const TEMPLATE_FIELDS = ['workflowType', 'instructions'] as const;
export type TemplateFormValues = Partial<Record<(typeof TEMPLATE_FIELDS)[number], string>>;

const templateSchema = z.object({ workflowType: workflowSchema, instructions: z.string() });

// A blank template means "none".
export async function saveTemplate(
  _prev: FormResult<TemplateFormValues>,
  formData: FormData,
): Promise<FormResult<TemplateFormValues>> {
  const values: TemplateFormValues = {};
  for (const field of TEMPLATE_FIELDS) {
    const value = formData.get(field);
    if (typeof value === 'string') values[field] = value;
  }
  const input = parseInput(templateSchema, values);
  if (!input.ok) return { ...input, values };
  const { workflowType, instructions } = input.value;
  getCore().agents.setTemplate(workflowType, instructions.trim() === '' ? null : instructions);
  refresh();
  return null;
}

export async function agentDeletionImpact(id: number): Promise<ActionResult<AgentAssignment[]>> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  const agents = getCore().agents;
  if (agents.getAgent(input.value) === null) return { ok: false, error: { code: 'NOT_FOUND' } };
  return { ok: true, value: agents.assignmentReferences(input.value) };
}

export async function deleteAgent(id: number): Promise<ActionResult<AgentAssignment[]>> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  const references = getCore().agents.deleteAgent(input.value);
  if (references === null) return { ok: false, error: { code: 'NOT_FOUND' } };
  refresh();
  return { ok: true, value: references };
}
