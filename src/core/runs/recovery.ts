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
    const folder = deps.repositories.get(run.repository)?.folder;
    const branch =
      folder !== undefined && fs.existsSync(folder) ? await (deps.currentBranch ?? gitCurrentBranch)(folder) : null;
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
  // No session process survives a restart: kill leftovers, keep each session's id so the next turn resumes lazily.
  const sessions = deps.db.prepare('SELECT id, pid, closed_at, close_requested_at FROM chat_sessions').all() as {
    id: number;
    pid: number | null;
    closed_at: number | null;
    close_requested_at: number | null;
  }[];
  for (const session of sessions) {
    if (session.pid !== null && session.pid > 0) killGroupIfAlive(session.pid);
  }
  deps.db
    .prepare(
      "UPDATE chat_sessions SET process_state = 'stopped', pid = NULL WHERE process_state <> 'stopped' OR pid IS NOT NULL",
    )
    .run();
  // No Run is active during startup recovery, so every per-Run copy left behind is an orphan.
  deps.dataDir.clearWorkspaces();
  // Open Interactive Chats keep their copy; closed, close-requested and unknown ones do not.
  const keep = new Set(sessions.filter((s) => s.closed_at === null && s.close_requested_at === null).map((s) => s.id));
  for (const id of deps.dataDir.chatWorkspaceIds()) if (!keep.has(id)) deps.dataDir.removeChatWorkspace(id);
  return runs.length;
}
