import { execFile } from 'node:child_process';
import fs from 'node:fs';

export type CopyWork = { uncommitted: boolean; unpushedCommits: number };

const GIT_TIMEOUT_MS = 5_000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
  });
}

// What closing a Chat would throw away: uncommitted changes and local commits that no remote has.
// Null when the copy does not exist (nothing to lose). A git failure counts as "unknown", reported as work.
export async function copyWork(copyPath: string): Promise<CopyWork | null> {
  if (!fs.existsSync(copyPath)) return null;
  const [status, unpushed] = await Promise.all([
    git(copyPath, ['status', '--porcelain']),
    git(copyPath, ['rev-list', '--count', '--branches', '--not', '--remotes']),
  ]);
  return {
    uncommitted: status === null ? true : status.trim() !== '',
    unpushedCommits: unpushed === null ? 0 : Number.parseInt(unpushed.trim(), 10) || 0,
  };
}
