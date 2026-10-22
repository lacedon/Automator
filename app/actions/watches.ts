'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { parseDuration, type PreviewTargetResult, type Result } from '@core/index';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult, FormResult } from './types';

const idSchema = z.number().int().positive();

function done(result: Result<unknown>): ActionResult {
  revalidatePath('/', 'layout');
  return result.ok ? { ok: true } : result;
}

export async function pauseWatch(id: number): Promise<ActionResult> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  return done(getCore().watches.pause(input.value));
}

export async function closeWatch(id: number): Promise<ActionResult> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  return done(getCore().watches.close(input.value));
}

export async function reopenWatch(id: number): Promise<ActionResult> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  return done(getCore().watches.reopen(input.value));
}

export async function deleteWatch(id: number): Promise<ActionResult> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  const result = done(getCore().watches.delete(input.value));
  if (!result.ok) return result;
  redirect('/watches');
}

const resumeSchema = z.object({
  id: z.coerce.number().int().positive(),
  note: z.string().optional(),
  runNow: z.enum(['1']).optional(),
});

export async function resumeWatch(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const input = parseInput(resumeSchema, {
    id: formData.get('id'),
    note: formData.get('note') ?? undefined,
    runNow: formData.get('runNow') ?? undefined,
  });
  if (!input.ok) return input;
  return done(getCore().watches.resume(input.value.id, { note: input.value.note, runNow: input.value.runNow === '1' }));
}

const runNowSchema = z.object({
  id: z.coerce.number().int().positive(),
  extraInstructions: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),
  reviewUnresolved: z.string().optional(),
});

export async function runWatchNow(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const input = parseInput(runNowSchema, {
    id: formData.get('id'),
    extraInstructions: formData.get('extraInstructions') ?? undefined,
    reviewUnresolved: formData.get('reviewUnresolved') ?? undefined,
  });
  if (!input.ok) return input;
  const { id, extraInstructions, reviewUnresolved } = input.value;
  return done(getCore().watches.runNow(id, { extraInstructions, reviewUnresolved: reviewUnresolved !== undefined }));
}

const FORM_FIELDS = ['id', 'target', 'repository', 'instructions', 'interval', 'model', 'initialReview'] as const;

export type WatchFormValues = Partial<Record<(typeof FORM_FIELDS)[number], string>>;

function formValues(formData: FormData): WatchFormValues {
  const values: WatchFormValues = {};
  for (const field of FORM_FIELDS) {
    const value = formData.get(field);
    if (typeof value === 'string') values[field] = value;
  }
  return values;
}

// Missing = leave unchanged, blank = the kind default (null), otherwise a duration like 15m or 2h.
const intervalField = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    const text = value.trim();
    if (text === '') return null;
    try {
      const ms = parseDuration(text);
      if (ms > 0) return ms;
    } catch {
      // reported below
    }
    ctx.addIssue({ code: 'custom', message: `Use a duration like 15m or 2h, got "${text}"` });
    return z.NEVER;
  });

// The form submits '' for the option that matches the config default, so the Watch keeps following the config.
const initialReviewField = z
  .enum(['', 'baseline-only', 'unresolved'])
  .optional()
  .transform((value) => (value === '' ? null : value));

const editableFields = {
  instructions: z.string().optional(),
  interval: intervalField,
  model: z.string().optional(),
  initialReview: initialReviewField,
};

const createSchema = z.object({ target: z.string(), repository: z.string(), ...editableFields });
const updateSchema = z.object({ id: z.coerce.number().int().positive(), ...editableFields });

export async function createWatch(
  _prev: FormResult<WatchFormValues>,
  formData: FormData,
): Promise<FormResult<WatchFormValues>> {
  const values = formValues(formData);
  const input = parseInput(createSchema, values);
  if (!input.ok) return { ...input, values };
  const { interval, initialReview, ...rest } = input.value;
  const result = getCore().watches.create({
    ...rest,
    intervalMs: interval ?? undefined,
    initialReview: initialReview ?? undefined,
  });
  if (!result.ok) return { ...result, values };
  revalidatePath('/', 'layout');
  redirect(`/watches/${result.value.id}`);
}

export async function updateWatch(
  _prev: FormResult<WatchFormValues>,
  formData: FormData,
): Promise<FormResult<WatchFormValues>> {
  const values = formValues(formData);
  const input = parseInput(updateSchema, values);
  if (!input.ok) return { ...input, values };
  const { id, instructions, interval, model, initialReview } = input.value;
  const result = getCore().watches.update(id, { instructions, intervalMs: interval, model, initialReview });
  if (!result.ok) return { ...result, values };
  revalidatePath('/', 'layout');
  redirect(`/watches/${id}`);
}

const previewSchema = z.object({ target: z.string(), repository: z.string() });

export async function previewTarget(target: string, repository: string): Promise<PreviewTargetResult> {
  const input = parseInput(previewSchema, { target, repository });
  if (!input.ok) return { kind: null, preview: null, error: input.error };
  return getCore().watches.previewTarget(input.value.target, input.value.repository);
}
