import fs from 'node:fs';
import { toRun } from '../db/rows';
import { finalizeRun, gitCurrentBranch, type RunExecutorDeps } from './runExecutor';

function killGroupIfAlive(pid: number): void {
  try {
    process.kill(-pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

export async function recoverInterruptedRuns(deps: RunExecutorDeps): Promise<number> {
  const runs = deps.db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY id").all().map(toRun);
  for (const run of runs) {
    if (run.pid !== null && run.pid > 0) killGroupIfAlive(run.pid);
    const folder = deps.config.repositories[run.repository]?.folder;
    const branch = folder !== undefined && fs.existsSync(folder) ? await (deps.currentBranch ?? gitCurrentBranch)(folder) : null;
    await finalizeRun(deps, run, {
      exitCode: null,
      resultStatus: 'error',
      outcome: null,
      summary: null,
      error: { code: 'INTERRUPTED', message: 'Worker restarted during the Run' },
      interrupted: 'worker-restart',
      branch,
    });
  }
  return runs.length;
}
