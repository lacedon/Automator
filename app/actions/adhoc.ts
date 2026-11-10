'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AppError } from '@core/index';
import { getCore } from '../lib/core';
import { requireWriteOnRepository, requireWriteOnRun } from '../lib/guard';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const FORM_FIELDS = ['repository', 'prompt', 'model', 'ticket', 'agentId'] as const;

export type AdhocFormValues = Partial<Record<(typeof FORM_FIELDS)[number], string>>;

export type AdhocFormState =
  | { ok: true; value: { runId: number; position: number | null; warning?: string } }
  | { ok: false; error: AppError; values: AdhocFormValues }
  | null;

const adhocSchema = z.object({
  repository: z.string(),
  // The queue requires a prompt unless a Ticket is linked.
  prompt: z.string().optional(),
  ticket: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),
  agentId: z.coerce.number().int().positive().optional(),
  // Blank = the config default model.
  model: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),
});

export async function queueAdhoc(_prev: AdhocFormState, formData: FormData): Promise<AdhocFormState> {
  const values: AdhocFormValues = {};
  for (const field of FORM_FIELDS) {
    const value = formData.get(field);
    if (typeof value === 'string') values[field] = value;
  }
  const input = parseInput(adhocSchema, values);
  if (!input.ok) return { ...input, values };
  const guard = await requireWriteOnRepository(input.value.repository);
  if (!guard.ok) return { ...guard, values };
  const core = getCore();
  const { queue } = core;
  const result = await queue.requestAdhoc(input.value);
  if (!result.ok) return { ...result, values };
  core.access.setOwner('runs', result.value.run.id, guard.userId);
  revalidatePath('/', 'layout');
  const { run, warning } = result.value;
  return {
    ok: true,
    value: { runId: run.id, position: queue.position(run.id), ...(warning === undefined ? {} : { warning }) },
  };
}

export async function deleteAdhocRun(id: number): Promise<ActionResult> {
  const input = parseInput(z.number().int().positive(), id);
  if (!input.ok) return input;
  const guard = await requireWriteOnRun(input.value);
  if (!guard.ok) return guard;
  const result = getCore().queue.deleteAdhoc(input.value);
  revalidatePath('/', 'layout');
  return result.ok ? { ok: true } : result;
}
