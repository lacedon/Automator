'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { PERMISSIONS, type Result } from '@core/index';
import { getCore } from '../lib/core';
import { currentUser } from '../lib/session';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const idSchema = z.number().int().positive();
const permissionsSchema = z.array(z.enum(PERMISSIONS));

// Managing users and roles takes a global `write`; checked here, not in the UI.
async function admin(): Promise<{ ok: true; userId: number } | Extract<ActionResult, { ok: false }>> {
  const user = await currentUser();
  if (user === null || !getCore().access.canAdminister(user.id)) return { ok: false, error: { code: 'FORBIDDEN' } };
  return { ok: true, userId: user.id };
}

function done<T>(result: Result<T>): ActionResult {
  if (!result.ok) return result;
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function createUser(username: string, password: string): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(z.object({ username: z.string(), password: z.string() }), { username, password });
  if (!input.ok) return input;
  return done(getCore().users.create(input.value.username, input.value.password));
}

export async function setUserDisabled(userId: number, disabled: boolean): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(z.object({ userId: idSchema, disabled: z.boolean() }), { userId, disabled });
  if (!input.ok) return input;
  if (input.value.disabled && input.value.userId === guard.userId)
    return { ok: false, error: { code: 'INVALID_INPUT', field: 'user', message: 'You cannot disable yourself' } };
  getCore().users.setDisabled(input.value.userId, input.value.disabled);
  return done({ ok: true, value: undefined });
}

export async function createRole(name: string, permissions: string[]): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(z.object({ name: z.string(), permissions: permissionsSchema }), { name, permissions });
  if (!input.ok) return input;
  return done(getCore().access.createRole(input.value.name, input.value.permissions));
}

export async function setRolePermissions(roleId: number, permissions: string[]): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(z.object({ roleId: idSchema, permissions: permissionsSchema }), { roleId, permissions });
  if (!input.ok) return input;
  return done(getCore().access.setRolePermissions(input.value.roleId, input.value.permissions));
}

export async function deleteRole(roleId: number): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(idSchema, roleId);
  if (!input.ok) return input;
  return done(getCore().access.deleteRole(input.value));
}

// A null projectId assigns the role globally.
export async function assignRole(userId: number, roleId: number, projectId: number | null): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(z.object({ userId: idSchema, roleId: idSchema, projectId: idSchema.nullable() }), {
    userId,
    roleId,
    projectId,
  });
  if (!input.ok) return input;
  return done(getCore().access.assign(input.value.userId, input.value.roleId, input.value.projectId));
}

export async function unassignRole(assignmentId: number): Promise<ActionResult> {
  const guard = await admin();
  if (!guard.ok) return guard;
  const input = parseInput(idSchema, assignmentId);
  if (!input.ok) return input;
  return done(getCore().access.unassign(input.value));
}
