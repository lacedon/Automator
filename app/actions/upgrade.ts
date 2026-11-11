'use server';

import { spawn } from 'node:child_process';
import process from 'node:process';
import { requireAdmin } from '../lib/guard';
import { getCore } from '../lib/core';
import type { ActionResult } from './types';

function failure(message: string): ActionResult {
  return { ok: false, error: { code: 'UPGRADE_FAILED', message } };
}

// Starts `npm run upgrade-and-restart` detached, then stops this application's supervisor without waiting for the
// upgrade. The script's own `npm run start` brings the application back once the port is free.
export async function upgradeAndRestart(): Promise<ActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard;

  const busy = getCore().db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')").get() as {
    n: number;
  };
  if (busy.n > 0)
    return failure(
      `Upgrade rejected: ${busy.n} Run${busy.n === 1 ? ' is' : 's are'} active or queued. Wait until they finish or cancel them.`,
    );

  const spawned = await new Promise<Error | null>((resolve) => {
    const child = spawn('npm', ['run', 'upgrade-and-restart'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.once('error', resolve);
    child.once('spawn', () => {
      child.unref();
      resolve(null);
    });
  });
  if (spawned !== null) return failure(`Could not start the upgrade: ${spawned.message}`);

  // Let the response reach the browser before the server goes down.
  setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 500).unref();
  return { ok: true };
}
