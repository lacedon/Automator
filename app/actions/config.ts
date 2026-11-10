'use server';

import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { readEditableConfig, writeEditableConfig, type EditableConfig } from '@core/index';
import { requireAdmin } from '../lib/guard';
import type { FormResult } from './types';

export type ConfigFormState = FormResult<EditableConfig>;

function failure(field: string, message: string, values: EditableConfig): ConfigFormState {
  return { ok: false, error: { code: 'INVALID_INPUT', field, message }, values };
}

function configPath(): string {
  return path.resolve(process.env.AUTOMATOR_CONFIG ?? 'automator.config.json');
}

function editableValues(formData: FormData, current: EditableConfig): EditableConfig {
  const serialized = formData.get('config');
  if (typeof serialized !== 'string') throw new Error('Missing configuration values');
  const input: unknown = JSON.parse(serialized);
  return validateEditableShape(input, current, 'config') as EditableConfig;
}

function validateEditableShape(input: unknown, current: unknown, field: string): unknown {
  if (Array.isArray(current)) {
    if (!Array.isArray(input)) throw new Error(`${field} must be an array`);
    const itemType = current.length === 0 ? (field.endsWith('.days') ? 'number' : 'string') : typeof current[0];
    if (input.some((value) => typeof value !== itemType)) throw new Error(`${field} entries must be ${itemType}s`);
    return input;
  }
  if (typeof current === 'object' && current !== null) {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new Error(`${field} must be an object`);
    const allowed = Object.keys(current);
    const submitted = Object.keys(input);
    if (allowed.length !== submitted.length || allowed.some((key) => !Object.hasOwn(input, key)))
      throw new Error(`${field} contains unsupported or missing fields`);
    return Object.fromEntries(
      allowed.map((key) => [
        key,
        validateEditableShape(
          (input as Record<string, unknown>)[key],
          (current as Record<string, unknown>)[key],
          `${field}.${key}`,
        ),
      ]),
    );
  }
  if (typeof input !== typeof current) throw new Error(`${field} has an unsupported value`);
  return input;
}

export async function saveConfig(_prev: ConfigFormState, formData: FormData): Promise<ConfigFormState> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ...guard, values: {} as EditableConfig };
  const file = configPath();
  let current: EditableConfig;
  try {
    current = readEditableConfig(file);
  } catch (error) {
    return failure('config', error instanceof Error ? error.message : String(error), {} as EditableConfig);
  }

  let values: EditableConfig;
  try {
    values = editableValues(formData, current);
  } catch (error) {
    return failure('config', error instanceof Error ? error.message : String(error), current);
  }

  try {
    writeEditableConfig(file, values);
  } catch (error) {
    return failure('config', error instanceof Error ? error.message : String(error), values);
  }

  revalidatePath('/', 'layout');
  return null;
}
