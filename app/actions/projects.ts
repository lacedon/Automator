'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Result } from '@core/index';
import { getCore } from '../lib/core';
import { SCOPE_COOKIE } from '../lib/scope';
import { parseInput } from './parse';
import type { ActionResult, FormResult } from './types';

const idSchema = z.number().int().positive();
const nameSchema = z.string().trim().min(1, 'Name is required');

function refresh(): void {
  revalidatePath('/', 'layout');
}

function toAction<T>(result: Result<T>): ActionResult {
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

export async function selectProject(scope: string): Promise<void> {
  const jar = await cookies();
  if (scope === 'all') jar.delete(SCOPE_COOKIE);
  else jar.set(SCOPE_COOKIE, scope, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  refresh();
}

export type ProjectFormValues = { name?: string };

export async function createProject(
  _prev: FormResult<ProjectFormValues>,
  formData: FormData,
): Promise<FormResult<ProjectFormValues>> {
  const name = formData.get('name');
  const values: ProjectFormValues = { name: typeof name === 'string' ? name : '' };
  const input = parseInput(nameSchema, values.name);
  if (!input.ok) return { ...input, values };
  const created = getCore().projects.create(input.value);
  if (!created.ok) return { ...created, values };
  refresh();
  return null;
}

export async function renameProject(id: number, name: string): Promise<ActionResult> {
  const input = parseInput(z.object({ id: idSchema, name: nameSchema }), { id, name });
  if (!input.ok) return input;
  return toAction(getCore().projects.rename(input.value.id, input.value.name));
}

export async function deleteProject(id: number): Promise<ActionResult> {
  const input = parseInput(idSchema, id);
  if (!input.ok) return input;
  return toAction(getCore().projects.delete(input.value));
}

export async function setProjectPromptAddition(id: number, promptAddition: string): Promise<ActionResult> {
  const input = parseInput(z.object({ id: idSchema, promptAddition: z.string() }), { id, promptAddition });
  if (!input.ok) return input;
  return toAction(getCore().projects.setPromptAddition(input.value.id, input.value.promptAddition));
}

export async function setProjectRepositories(id: number, repositories: string[]): Promise<ActionResult> {
  const input = parseInput(z.object({ id: idSchema, repositories: z.array(z.string().min(1)) }), {
    id,
    repositories,
  });
  if (!input.ok) return input;
  return toAction(getCore().projects.setRepositories(input.value.id, input.value.repositories));
}
