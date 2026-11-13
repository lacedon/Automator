import { z } from 'zod';
import { parseDuration } from '@core/index';
import { getCore } from '../../lib/core';
import { requireWriteOnRepository } from '../../lib/guard';
import { errorResponse, json, parseBody } from '../http';

export const dynamic = 'force-dynamic';

const intervalField = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    try {
      const ms = parseDuration(value.trim());
      if (ms > 0) return ms;
    } catch {
      // reported below
    }
    ctx.addIssue({ code: 'custom', message: `Use a duration like 15m or 2h, got "${value}"` });
    return z.NEVER;
  });

const createSchema = z.object({
  target: z.string(),
  repository: z.string(),
  interval: intervalField,
  name: z.string().optional(),
  model: z.string().optional(),
  instructions: z.string().optional(),
  initialReview: z.enum(['baseline-only', 'unresolved']).optional(),
});

// Equivalent to `automator automation add`.
export async function POST(request: Request): Promise<Response> {
  const body = await parseBody(request, createSchema);
  if (!body.ok) return body.response;
  const { interval, ...rest } = body.value;
  const guard = await requireWriteOnRepository(rest.repository);
  if (!guard.ok) return errorResponse(guard.error);
  const core = getCore();
  const result = core.watches.create({ ...rest, intervalMs: interval });
  if (!result.ok) return errorResponse(result.error);
  core.access.setOwner('watches', result.value.id, guard.userId);
  const { id, kind, repository } = result.value;
  return json({ automationId: id, kind, repository }, 201);
}
