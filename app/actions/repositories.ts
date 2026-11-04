'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { RepositoryInput, Result } from '@core/index';
import { getCore } from '../lib/core';
import { parseInput } from './parse';
import type { ActionResult, FormResult } from './types';

const repositorySchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  folder: z.string().trim().min(1, 'Folder is required'),
  gitlab: z.string().trim().nullable(),
  github: z.string().trim().nullable(),
  jira: z.string().trim().nullable(),
  validate: z.array(z.string()),
});

const repositoryInputSchema = repositorySchema.transform(
  ({ gitlab, github, jira, ...repository }): RepositoryInput => ({
    ...repository,
    gitlab: gitlab || null,
    github: github || null,
    jira: jira || null,
  }),
);

function refresh(): void {
  revalidatePath('/', 'layout');
}

function toAction<T>(result: Result<T>): ActionResult {
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

function text(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

function readForm(data: FormData): RepositoryInput {
  return {
    name: text(data, 'name'),
    folder: text(data, 'folder'),
    gitlab: text(data, 'gitlab') || null,
    github: text(data, 'github') || null,
    jira: text(data, 'jira') || null,
    validate: text(data, 'validate')
      .split(/\r?\n/)
      .map((command) => command.trim())
      .filter(Boolean),
  };
}

export async function createRepository(
  _prev: FormResult<RepositoryInput>,
  formData: FormData,
): Promise<FormResult<RepositoryInput>> {
  const values = readForm(formData);
  const input = parseInput(repositoryInputSchema, values);
  if (!input.ok) return { ...input, values };
  const created = getCore().repositories.create(input.value);
  if (!created.ok) return { ...created, values };
  refresh();
  return null;
}

export async function updateRepository(name: string, input: RepositoryInput): Promise<ActionResult> {
  const parsed = parseInput(z.object({ name: z.string().trim().min(1), input: repositoryInputSchema }), {
    name,
    input,
  });
  if (!parsed.ok) return parsed;
  return toAction(getCore().repositories.update(parsed.value.name, parsed.value.input));
}

export async function deleteRepository(name: string): Promise<ActionResult> {
  const parsed = parseInput(z.string().trim().min(1), name);
  if (!parsed.ok) return parsed;
  return toAction(getCore().repositories.delete(parsed.value));
}
