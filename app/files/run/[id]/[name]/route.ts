import path from 'node:path';
import { getCore } from '../../../../lib/core';
import { notFound, serveDataFile } from '../../../serve';

export const dynamic = 'force-dynamic';

const RUN_FILES = new Set(['prompt.md', 'transcript.md', 'result.json', 'copilot-result.json', 'cli.log']);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }): Promise<Response> {
  const { id, name } = await ctx.params;
  const { dataDir } = getCore();
  if (!/^\d+$/.test(id) || !RUN_FILES.has(name)) return notFound();
  return serveDataFile(dataDir, path.join(dataDir.runDir(Number(id)), name));
}
