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

describe('copyWork: commands named in the git config of the copy', () => {
  // The agent writes the copy, so its .git/config and .gitattributes are untrusted. Every driver below would run a
  // command with the dashboard's permissions if git were allowed to use it.
  function armedCopy(configure: (copy: string, hook: string) => void) {
    const copy = cloneWithRemote();
    const marker = path.join(path.dirname(copy), 'ran');
    const hook = path.join(path.dirname(copy), 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    configure(copy, hook);
    // Same size, new content: git cannot tell from the stat data alone, so it hashes the file (and so runs its clean
    // filter, if it is allowed to).
    fs.writeFileSync(path.join(copy, 'a.txt'), 'b');
    return { copy, marker };
  }

  test('a filter.<name>.clean command is never executed, and the change is still reported', async () => {
    const { copy, marker } = armedCopy((dir, hook) => {
      fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
      git(dir, 'config', 'filter.evil.clean', hook);
    });
    const work = await copyWork(copy);
    expect(fs.existsSync(marker)).toBe(false);
    expect(work).toMatchObject({ uncommitted: true });
  });

  test('filter smudge and process commands, also from an included config file, are never executed', async () => {
    const { copy, marker } = armedCopy((dir, hook) => {
      fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
      fs.writeFileSync(
        path.join(dir, 'extra.cfg'),
        `[filter "evil"]\n\tprocess = ${hook}\n\tsmudge = ${hook}\n\tclean = ${hook}\n\trequired = true\n`,
      );
      git(dir, 'config', 'include.path', path.join(dir, 'extra.cfg'));
    });
    const work = await copyWork(copy);
    expect(fs.existsSync(marker)).toBe(false);
    expect(work).not.toBeNull();
  });

  test('a filter named in .git/info/attributes is not run either', async () => {
    const { copy, marker } = armedCopy((dir, hook) => {
      fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=evil\n');
      git(dir, 'config', 'filter.evil.clean', hook);
    });
    await copyWork(copy);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('the checks do not read the global git config of the dashboard user', async () => {
    const copy = cloneWithRemote();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-status-home-'));
    dirs.push(home);
    const marker = path.join(home, 'ran');
    const hook = path.join(home, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\tfsmonitor = ${hook}\n`);
    const previous = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    try {
      await copyWork(copy);
    } finally {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('copyWork', () => {
  // The copy is written by the agent, and the dashboard runs git in it with its own environment: the checks must not
  // execute commands named in the copy's git config.
  test('a core.fsmonitor command in the copy is never executed', async () => {
    const copy = cloneWithRemote();
    const marker = path.join(path.dirname(copy), 'fsmonitor-ran');
    const hook = path.join(path.dirname(copy), 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(copy, 'config', 'core.fsmonitor', hook);

    await copyWork(copy);

    expect(fs.existsSync(marker)).toBe(false);
  });

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
