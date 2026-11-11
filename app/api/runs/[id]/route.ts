import { getCore } from '../../../lib/core';
import { canReadRun } from '../../../lib/guard';
import { errorResponse, json } from '../../http';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id) || !(await canReadRun(Number(id)))) return errorResponse({ code: 'NOT_FOUND' });
  const detail = await getCore().read.runDetail(Number(id));
  if (detail === null) return errorResponse({ code: 'NOT_FOUND' });
  const { run } = detail;
  if (run.status !== 'finished') {
    return json({ runId: run.id, status: 'pending', error: null, result: null }, 202);
  }
  const failed = run.resultStatus === 'error' || run.error !== null || run.interrupted !== null;
  return json(
    {
      runId: run.id,
      status: 'finished',
      error: failed
        ? (run.error ?? {
            code: run.interrupted === null ? 'RUN_FAILED' : 'RUN_INTERRUPTED',
            message: run.interrupted === null ? (run.summary ?? 'The Run failed') : `Interrupted: ${run.interrupted}`,
          })
        : null,
      result: failed ? null : { outcome: run.outcome, summary: run.summary, branch: run.branch },
    },
    200,
  );
}
