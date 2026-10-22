import type { z } from 'zod';
import type { ActionResult } from './types';

export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.output<S> } | Extract<ActionResult<never>, { ok: false }> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, error: { code: 'INVALID_INPUT', field: issue.path.join('.'), message: issue.message } };
}
