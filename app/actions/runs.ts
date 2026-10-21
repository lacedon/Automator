'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult } from './types';

export async function cancelRun(id: number): Promise<ActionResult<'deleted' | 'cancel-requested'>> {
  const input = parseInput(z.number().int().positive(), id);
  if (!input.ok) return input;
  const result = getCore().queue.cancel(input.value);
  revalidatePath('/', 'layout');
  return result;
}
