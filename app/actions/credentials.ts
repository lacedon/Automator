'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { getCore } from '../lib/core';
import { credentialNames } from '../lib/credentialNames';
import { currentUser } from '../lib/session';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN' } } as const;

export async function saveCredential(name: string, value: string): Promise<ActionResult> {
  const user = await currentUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(z.object({ name: z.string(), value: z.string() }), { name, value });
  if (!input.ok) return input;
  if (!credentialNames().includes(input.value.name))
    return { ok: false, error: { code: 'INVALID_INPUT', field: 'name', message: 'Unknown credential name' } };
  const saved = getCore().credentials.set(user.id, input.value.name, input.value.value);
  if (!saved.ok) return saved;
  audit('credential saved', { user: user.id, name: input.value.name });
  revalidatePath('/account');
  return { ok: true };
}

export async function removeCredential(name: string): Promise<ActionResult> {
  const user = await currentUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(z.string().min(1), name);
  if (!input.ok) return input;
  getCore().credentials.remove(user.id, input.value);
  audit('credential removed', { user: user.id, name: input.value });
  revalidatePath('/account');
  return { ok: true };
}
