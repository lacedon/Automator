'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCore } from '../lib/core';
import { currentUser } from '../lib/session';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN' } } as const;
const idSchema = z.number().int().positive();

// Every signed-in user manages only their own tokens. The secret is returned once and never stored.
export async function createToken(name: string, expiresAt: number | null): Promise<ActionResult<string>> {
  const user = await currentUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(z.object({ name: z.string(), expiresAt: z.number().int().nullable() }), {
    name,
    expiresAt,
  });
  if (!input.ok) return input;
  const created = getCore().users.createToken(user.id, input.value.name, input.value.expiresAt);
  if (!created.ok) return created;
  revalidatePath('/account');
  return { ok: true, value: created.value.token };
}

export async function regenerateToken(id: number): Promise<ActionResult<string>> {
  const user = await currentUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  const next = getCore().users.regenerateToken(user.id, input.value);
  if (!next.ok) return next;
  revalidatePath('/account');
  return { ok: true, value: next.value.token };
}

export async function revokeToken(id: number): Promise<ActionResult<string>> {
  const user = await currentUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  getCore().users.revokeToken(user.id, input.value);
  revalidatePath('/account');
  return { ok: true };
}
