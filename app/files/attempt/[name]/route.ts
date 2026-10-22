import path from 'node:path';
import { getCore } from '../../../lib/core';
import { notFound, serveDataFile } from '../../serve';

export const dynamic = 'force-dynamic';

const ATTEMPT_FILE = /^[\w.-]+\.json$/;

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await ctx.params;
  const { dataDir } = getCore();
  if (!ATTEMPT_FILE.test(name) || name.startsWith('.')) return notFound();
  return serveDataFile(dataDir, path.join(dataDir.attemptsDir, name));
}
