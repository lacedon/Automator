import { execFile } from 'node:child_process';
import fs from 'node:fs';

// `unknown` means a git check failed or could not be made: the copy may hold work, so the caller must confirm.
export type CopyWork = { uncommitted: boolean; unpushedCommits: number; unknown: boolean };

const GIT_TIMEOUT_MS = 5_000;

// The copy is written by the agent. `core.fsmonitor` in its .git/config names a command that `git status` would run
// with the dashboard's environment, so it is switched off for every check.
const SAFE_GIT = ['-c', 'core.fsmonitor=false'];

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', [...SAFE_GIT, ...args], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

async function unpushed(copyPath: string, baselineFolder: string | null): Promise<number | null> {
  const remotes = await git(copyPath, ['remote']);
  if (remotes === null) return null;
  let count: string | null;
  if (remotes.trim() !== '') {
    count = await git(copyPath, ['rev-list', '--count', '--branches', '--not', '--remotes']);
  } else {
    // Without a remote every commit looks unpushed. The copy came from the Repository folder, so the work is what
    // the folder's branches do not have. Without that baseline there is no accurate answer.
    if (baselineFolder === null) return null;
    const tips = await git(baselineFolder, ['for-each-ref', '--format=%(objectname)', 'refs/heads']);
    if (tips === null) return null;
    const ids = tips.split('\n').filter((line) => line !== '');
    count = await git(copyPath, ['rev-list', '--count', '--branches', '--not', ...ids]);
  }
  if (count === null) return null;
  const parsed = Number.parseInt(count.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// What closing a Chat would throw away: uncommitted changes and local commits that nothing else has.
// Null when the copy does not exist (nothing to lose). Any git failure is "unknown", never "no work".
export async function copyWork(copyPath: string, baselineFolder: string | null = null): Promise<CopyWork | null> {
  if (!fs.existsSync(copyPath)) return null;
  const [status, count] = await Promise.all([
    git(copyPath, ['status', '--porcelain']),
    unpushed(copyPath, baselineFolder),
  ]);
  return {
    uncommitted: status !== null && status.trim() !== '',
    unpushedCommits: count ?? 0,
    unknown: status === null || count === null,
  };
}
