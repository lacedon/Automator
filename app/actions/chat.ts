'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AppError } from '@core/index';
import { getCore } from '../lib/core';
import { parseInput } from './parse';

export type ChatFormState =
  { ok: true; value: { runId: number } } | { ok: false; error: AppError; values: { message?: string } } | null;

const chatSchema = z.object({
  runId: z
    .string()
    .regex(/^[1-9]\d*$/, 'Run id must be a positive integer')
    .transform(Number),
  message: z.string(),
});

export async function sendRunMessage(_prev: ChatFormState, formData: FormData): Promise<ChatFormState> {
  const message = formData.get('message');
  const values = typeof message === 'string' ? { message } : {};
  const input = parseInput(chatSchema, { runId: formData.get('runId'), message });
  if (!input.ok) return { ...input, values };
  const result = getCore().queue.requestFollowUp(input.value.runId, input.value.message);
  if (!result.ok) return { ...result, values };
  revalidatePath('/', 'layout');
  return { ok: true, value: { runId: result.value.run.id } };
}
