'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AppError } from '@core/index';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const FORM_FIELDS = ['repository', 'prompt', 'model'] as const;

export type AdhocFormValues = Partial<Record<(typeof FORM_FIELDS)[number], string>>;

export type AdhocFormState =
  | { ok: true; value: { runId: number; position: number | null } }
  | { ok: false; error: AppError; values: AdhocFormValues }
  | null;

const adhocSchema = z.object({
  repository: z.string(),
  prompt: z.string().trim().min(1, 'Prompt is required'),
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
  const { queue } = getCore();
  const result = queue.enqueueAdhocChecked(input.value);
  if (!result.ok) return { ...result, values };
  revalidatePath('/', 'layout');
  return { ok: true, value: { runId: result.value.id, position: queue.position(result.value.id) } };
}

export async function deleteAdhocRun(id: number): Promise<ActionResult> {
  const input = parseInput(z.number().int().positive(), id);
  if (!input.ok) return input;
  const result = getCore().queue.deleteAdhoc(input.value);
  revalidatePath('/', 'layout');
  return result.ok ? { ok: true } : result;
}
