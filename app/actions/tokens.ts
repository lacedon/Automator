'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { getCore } from '../lib/core';
import { sessionUser } from '../lib/session';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN' } } as const;
const idSchema = z.number().int().positive();

// Session-cookie only, so an access token can never mint or alter tokens. Users manage only their own tokens. The secret is returned once and never stored.
export async function createToken(name: string, expiresAt: number | null): Promise<ActionResult<string>> {
  const user = await sessionUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(z.object({ name: z.string(), expiresAt: z.number().int().nullable() }), {
    name,
    expiresAt,
  });
  if (!input.ok) return input;
  const created = getCore().users.createToken(user.id, input.value.name, input.value.expiresAt);
  if (!created.ok) return created;
  audit('token created', { user: user.id, token: created.value.id });
  revalidatePath('/account');
  return { ok: true, value: created.value.token };
}

export async function regenerateToken(id: number): Promise<ActionResult<string>> {
  const user = await sessionUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  const next = getCore().users.regenerateToken(user.id, input.value);
  if (!next.ok) return next;
  audit('token regenerated', { user: user.id, token: input.value });
  revalidatePath('/account');
  return { ok: true, value: next.value.token };
}

export async function revokeToken(id: number): Promise<ActionResult<string>> {
  const user = await sessionUser();
  if (user === null) return FORBIDDEN;
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  getCore().users.revokeToken(user.id, input.value);
  audit('token revoked', { user: user.id, token: input.value });
  revalidatePath('/account');
  return { ok: true };
}
