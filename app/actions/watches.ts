'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { Result } from '@core/index';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult } from './types';

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
