'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult } from './types';

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
  const result = getCore().watches.resume(input.value.id, { note: input.value.note, runNow: input.value.runNow === '1' });
  revalidatePath('/', 'layout');
  return result.ok ? { ok: true } : result;
}
