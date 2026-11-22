import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// `unknown` means a git check failed or could not be made: the copy may hold work, so the caller must confirm.
export type CopyWork = { uncommitted: boolean; unpushedCommits: number; unknown: boolean };

const GIT_TIMEOUT_MS = 5_000;

// The copy is written by the agent, so its .git/config, .gitattributes and .git/info/attributes are untrusted, and git
// runs commands that they name: core.fsmonitor, and filter.<name>.clean/smudge/process for any path an attribute
// assigns a filter to (git status hashes files whose stat data changed, which runs the clean filter). The dashboard
// must never execute them. Defence in depth, in this order:
//  1. a scrubbed environment: no dashboard secrets, no global or system git config, no optional locks;
//  2. per-invocation overrides: fsmonitor and the attributes file are off, and every filter command that the
//     configuration (local, worktree or included files) defines is blanked, which git treats as "no filter";
//  3. the commands are read-only (status, rev-list, for-each-ref, remote).
// Not covered: submodules (git status descends into them with the same overrides, but a filter that only their own
// config defines is not blanked). A copy that cannot be checked reports `unknown`, so the user must confirm the close.
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: os.tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};
const BASE_OVERRIDES = ['-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null'];
const FILTER_COMMAND = /^(filter\..+)\.(clean|smudge|process)$/;

function run(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, env: GIT_ENV as NodeJS.ProcessEnv }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

// Blanks every configured filter command (and drops `required`, so a blanked filter is not an error).
async function filterOverrides(cwd: string): Promise<string[] | null> {
  const keys = await run(cwd, [...BASE_OVERRIDES, 'config', '--name-only', '--get-regexp', '^filter\\.']);
  // Exit status 1 means "no such key" (no filters), which `run` reports as null too: tell it apart by asking again.
  if (keys === null) return (await run(cwd, [...BASE_OVERRIDES, 'config', '--list'])) === null ? null : [];
  const overrides: string[] = [];
  for (const key of keys.split('\n')) {
    const match = FILTER_COMMAND.exec(key.trim());
    if (match === null) continue;
    overrides.push('-c', `${key.trim()}=`, '-c', `${match[1]}.required=false`);
  }
  return overrides;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const filters = await filterOverrides(cwd);
  if (filters === null) return null;
  return run(cwd, [...BASE_OVERRIDES, ...filters, ...args]);
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
