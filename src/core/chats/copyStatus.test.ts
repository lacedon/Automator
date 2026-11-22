import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { copyWork } from './copyStatus';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });

// A clone of a bare remote with one pushed commit.
function cloneWithRemote(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-status-'));
  dirs.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const copy = path.join(root, 'copy');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'init', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');
  git(root, 'clone', remote, copy);
  return copy;
}

describe('copyWork', () => {
  test('a clean pushed copy reports no work', async () => {
    expect(await copyWork(cloneWithRemote())).toEqual({ uncommitted: false, unpushedCommits: 0, unknown: false });
  });

  test('uncommitted changes are reported', async () => {
    const copy = cloneWithRemote();
    fs.writeFileSync(path.join(copy, 'new.txt'), 'x');
    expect(await copyWork(copy)).toEqual({ uncommitted: true, unpushedCommits: 0, unknown: false });
    fs.rmSync(path.join(copy, 'new.txt'));
    fs.writeFileSync(path.join(copy, 'a.txt'), 'changed');
    expect(await copyWork(copy)).toEqual({ uncommitted: true, unpushedCommits: 0, unknown: false });
  });

  test('local commits not on any remote are counted', async () => {
    const copy = cloneWithRemote();
    for (const name of ['b', 'c']) {
      fs.writeFileSync(path.join(copy, `${name}.txt`), name);
      git(copy, 'add', '.');
      git(copy, 'commit', '-m', name);
    }
    git(copy, 'checkout', '-b', 'topic');
    fs.writeFileSync(path.join(copy, 'd.txt'), 'd');
    git(copy, 'add', '.');
    git(copy, 'commit', '-m', 'd');

    expect(await copyWork(copy)).toEqual({ uncommitted: false, unpushedCommits: 3, unknown: false });
    git(copy, 'push', 'origin', 'main', 'topic');
    expect(await copyWork(copy)).toEqual({ uncommitted: false, unpushedCommits: 0, unknown: false });
  });

  test('a missing copy returns null', async () => {
    expect(await copyWork(path.join(os.tmpdir(), 'definitely-not-here-xyz'))).toBeNull();
  });

  test('a git failure is unknown, never "no work"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-status-plain-'));
    dirs.push(dir);
    expect((await copyWork(dir))?.unknown).toBe(true);
  });

  describe('a copy without remotes', () => {
    // The copy is a cp of the Repository folder: commits the baseline already has are not work.
    function copyOfLocalRepo(): { baseline: string; copy: string } {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-status-local-'));
      dirs.push(root);
      const baseline = path.join(root, 'baseline');
      git(root, 'init', '-b', 'main', baseline);
      fs.writeFileSync(path.join(baseline, 'a.txt'), 'a');
      git(baseline, 'add', '.');
      git(baseline, 'commit', '-m', 'first');
      const copy = path.join(root, 'copy');
      fs.cpSync(baseline, copy, { recursive: true });
      return { baseline, copy };
    }

    test('only commits missing from the Repository folder count', async () => {
      const { baseline, copy } = copyOfLocalRepo();
      expect(await copyWork(copy, baseline)).toEqual({ uncommitted: false, unpushedCommits: 0, unknown: false });
      fs.writeFileSync(path.join(copy, 'b.txt'), 'b');
      git(copy, 'add', '.');
      git(copy, 'commit', '-m', 'b');
      expect(await copyWork(copy, baseline)).toEqual({ uncommitted: false, unpushedCommits: 1, unknown: false });
    });

    test('without a baseline the unpushed state is unknown', async () => {
      const { copy } = copyOfLocalRepo();
      expect(await copyWork(copy)).toMatchObject({ unknown: true });
    });

    test('a baseline the copy cannot compare against is unknown', async () => {
      const { baseline, copy } = copyOfLocalRepo();
      fs.writeFileSync(path.join(baseline, 'later.txt'), 'later');
      git(baseline, 'add', '.');
      git(baseline, 'commit', '-m', 'later');
      expect(await copyWork(copy, baseline)).toMatchObject({ unknown: true });
    });
  });
});
