'use server';

import { revalidatePath } from 'next/cache';
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

export async function cancelRun(id: number): Promise<ActionResult<'deleted' | 'cancel-requested'>> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  const result = getCore().queue.cancel(input.value);
  revalidatePath('/', 'layout');
  return result;
}

export async function cancelQueued(id: number): Promise<ActionResult> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  return done(getCore().queue.cancelQueued(input.value));
}

export async function closeWatchFromQueue(watchId: number): Promise<ActionResult> {
  const input = parseInput(idSchema, watchId);
  if (!input.ok) return input;
  return done(getCore().watches.close(input.value));
}
