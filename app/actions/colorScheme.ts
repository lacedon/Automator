'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { getCore } from '../lib/core';
import { requireAdmin } from '../lib/guard';
import { currentUser } from '../lib/session';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN' } } as const;

// The scheme everyone sees until they pick their own.
export async function setApplicationColorScheme(scheme: string | null): Promise<ActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard;
  const input = parseInput(z.string(), scheme);
  if (!input.ok) return input;
  const saved = getCore().settings.setApplicationColorScheme(input.value);
  if (!saved.ok) return saved;
  audit('application color scheme changed', { user: guard.userId, scheme: input.value });
  revalidatePath('/', 'layout');
  return { ok: true };
}

// The signed-in user's own scheme; `null` goes back to the application default.
export async function setUserColorScheme(scheme: string | null): Promise<ActionResult> {
  const user = await currentUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(z.string().nullable(), scheme);
  if (!input.ok) return input;
  const saved = getCore().settings.setUserColorScheme(user.id, input.value);
  if (!saved.ok) return saved;
  audit('user color scheme changed', { user: user.id, scheme: input.value });
  revalidatePath('/', 'layout');
  return { ok: true };
}
