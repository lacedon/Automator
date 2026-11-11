import { z } from 'zod';
import { getCore } from '../../lib/core';
import { requireWriteOnRepository } from '../../lib/guard';
import { errorResponse, json, parseBody } from '../http';

export const dynamic = 'force-dynamic';

const adhocSchema = z.object({
  repository: z.string(),
  prompt: z.string().optional(),
  ticket: z.string().optional(),
  model: z.string().optional(),
});

// Equivalent to `automator run`; answers at once with the Run id to poll at GET /api/runs/{id}.
export async function POST(request: Request): Promise<Response> {
  const body = await parseBody(request, adhocSchema);
  if (!body.ok) return body.response;
  const guard = await requireWriteOnRepository(body.value.repository);
  if (!guard.ok) return errorResponse(guard.error);
  const core = getCore();
  const result = await core.queue.requestAdhoc(body.value);
  if (!result.ok) return errorResponse(result.error);
  const { run, warning } = result.value;
  core.access.setOwner('runs', run.id, guard.userId);
  return json({ runId: run.id, ...(warning === undefined ? {} : { warning }) }, 202);
}
