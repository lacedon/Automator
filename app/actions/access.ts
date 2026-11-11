'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { PERMISSIONS, type Result } from '@core/index';
import { audit } from '../lib/audit';
import { getCore } from '../lib/core';
import { requireAdmin } from '../lib/guard';
import { parseInput } from './parse';
import type { ActionResult } from './types';

const idSchema = z.number().int().positive();
const permissionsSchema = z.array(z.enum(PERMISSIONS));

type Details = Record<string, string | number | null>;

// Runs an admin-only change and audits it once, with its outcome, whether it succeeded, was rejected or failed.
async function mutate<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  operation: string,
  describe: (input: z.output<S>) => Details,
  run: (input: z.output<S>, actor: number) => Result<unknown>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard;
  const input = parseInput(schema, raw);
  const result: Result<unknown> = input.ok ? run(input.value, guard.userId) : input;
  const details = input.ok ? describe(input.value) : {};
  audit(operation, {
    actor: guard.userId,
    ...details,
    outcome: result.ok ? 'success' : `rejected:${result.error.code}`,
  });
  if (!result.ok) return result;
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function createUser(username: string, password: string): Promise<ActionResult> {
  return mutate(
    z.object({ username: z.string(), password: z.string() }),
    { username, password },
    'user created',
    (i) => ({ username: i.username }),
    (i) => getCore().users.create(i.username, i.password),
  );
}

export async function setUserDisabled(userId: number, disabled: boolean): Promise<ActionResult> {
  return mutate(
    z.object({ userId: idSchema, disabled: z.boolean() }),
    { userId, disabled },
    disabled ? 'user disabled' : 'user enabled',
    (i) => ({ user: i.userId }),
    (i, actor) => {
      if (i.disabled && i.userId === actor)
        return { ok: false, error: { code: 'INVALID_INPUT', field: 'user', message: 'You cannot disable yourself' } };
      getCore().users.setDisabled(i.userId, i.disabled);
      return { ok: true, value: undefined };
    },
  );
}

export async function createRole(name: string, permissions: string[]): Promise<ActionResult> {
  return mutate(
    z.object({ name: z.string(), permissions: permissionsSchema }),
    { name, permissions },
    'role created',
    (i) => ({ name: i.name, permissions: i.permissions.join(',') }),
    (i) => getCore().access.createRole(i.name, i.permissions),
  );
}

export async function setRolePermissions(roleId: number, permissions: string[]): Promise<ActionResult> {
  return mutate(
    z.object({ roleId: idSchema, permissions: permissionsSchema }),
    { roleId, permissions },
    'role permissions changed',
    (i) => ({ role: i.roleId, permissions: i.permissions.join(',') }),
    (i) => getCore().access.setRolePermissions(i.roleId, i.permissions),
  );
}

export async function deleteRole(roleId: number): Promise<ActionResult> {
  return mutate(
    idSchema,
    roleId,
    'role deleted',
    (id) => ({ role: id }),
    (id) => getCore().access.deleteRole(id),
  );
}

// A null projectId assigns the role globally.
export async function assignRole(userId: number, roleId: number, projectId: number | null): Promise<ActionResult> {
  return mutate(
    z.object({ userId: idSchema, roleId: idSchema, projectId: idSchema.nullable() }),
    { userId, roleId, projectId },
    'role assigned',
    (i) => ({ user: i.userId, role: i.roleId, project: i.projectId }),
    (i) => getCore().access.assign(i.userId, i.roleId, i.projectId),
  );
}

export async function unassignRole(assignmentId: number): Promise<ActionResult> {
  return mutate(
    idSchema,
    assignmentId,
    'role unassigned',
    (id) => ({ assignment: id }),
    (id) => getCore().access.unassign(id),
  );
}
