import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ChatSessionService } from '../chats/chatSessionService';
import { QueueService } from '../queue/queueService';
import { expireOrphanedQuestions } from '../chats/questions';
import { providerOptions } from '../config/providers';
import { toRun } from '../db/rows';
import type { ProviderName } from '../domain/types';
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

// A stored pid may belong to an unrelated process by now: only kill it if its command line still names the
// provider (or ACP adapter) executable we started.
export function processLooksLikeSession(pid: number, names: string[]): boolean {
  let command: string;
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return false; // no such process
  }
  return names.some((name) => name !== '' && command.includes(name));
}

function expectedNames(deps: RunExecutorDeps, repository: string, provider: ProviderName): string[] {
  const options = providerOptions(deps.configFor?.(repository) ?? deps.config, provider);
  return [options.bin, options.acpBin].flatMap((bin) => (bin === undefined ? [] : [path.basename(bin)]));
}

function killSessionProcess(deps: RunExecutorDeps, pid: number, repository: string, provider: ProviderName): void {
  const owns = deps.ownsSessionProcess ?? processLooksLikeSession;
  if (owns(pid, expectedNames(deps, repository, provider))) killGroupIfAlive(pid);
  else console.warn(`Recovery: pid ${pid} is not a ${provider} session process any more; leaving it alone`);
}

export async function recoverInterruptedRuns(deps: RunExecutorDeps): Promise<number> {
  const runs = deps.db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY id").all().map(toRun);
  for (const run of runs) {
    if (run.pid !== null && run.pid > 0) {
      if (run.chatSessionId === null) killGroupIfAlive(run.pid);
      else killSessionProcess(deps, run.pid, run.repository, run.provider);
    }
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
  // A question whose Run was just interrupted cannot be waited on; it stays pending for an `answer` turn.
  expireOrphanedQuestions(
    deps.db,
    deps.queue ??
      new QueueService(
        deps.db,
        deps.clock,
        deps.dataDir,
        deps.config,
        deps.repositories,
        new ChatSessionService(deps.db, deps.clock),
        {
          ...(deps.configFor === undefined ? {} : { configFor: deps.configFor }),
        },
      ),
    deps.clock.now(),
  );
  // No session process survives a restart: kill leftovers, keep each session's id so the next turn resumes lazily.
  const sessions = deps.db
    .prepare('SELECT id, pid, repository, provider, closed_at, close_requested_at FROM chat_sessions')
    .all() as {
    id: number;
    pid: number | null;
    repository: string;
    provider: ProviderName;
    closed_at: number | null;
    close_requested_at: number | null;
  }[];
  for (const session of sessions) {
    if (session.pid !== null && session.pid > 0)
      killSessionProcess(deps, session.pid, session.repository, session.provider);
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
  // A copy interrupted by the restart is incomplete; the next turn makes a fresh one.
  deps.dataDir.removeIncompleteChatCopies();
  return runs.length;
}
