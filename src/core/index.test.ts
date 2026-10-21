import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';
import { insertWatch } from '../../test/helpers/db';
import { createCore, type GitLabClient } from './index';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MR_URL = 'https://gitlab.example.com/g/p/-/merge_requests/7';

function fakeGitLab(): GitLabClient & { me: ReturnType<typeof vi.fn> } {
  return {
    me: vi.fn(async () => ({ id: 42, username: 'me' })),
    mr: async () => ({
      title: 'Fix it',
      state: 'opened',
      sha: 'abc',
      sourceBranch: 'feat/fix',
      detailedMergeStatus: 'mergeable',
      headPipeline: null,
      webUrl: MR_URL,
    }),
    discussions: async () => [],
  };
}

function setup() {
  const config = testConfig();
  const clock = fakeClock();
  const gitlab = fakeGitLab();
  const open = () => createCore(config, { clock, gitlab: () => gitlab });
  const core = open();
  cleanups.push(() => {
    core.close();
    fs.rmSync(path.dirname(config.dataDir), { recursive: true, force: true });
  });
  return { core, clock, gitlab, open };
}

describe('createCore', () => {
  test('previews MR targets through the injected GitLab client', async () => {
    const { core } = setup();
    expect(await core.watches.previewTarget(MR_URL, 'pages')).toEqual({
      kind: 'mr',
      preview: { title: 'Fix it', state: 'opened', sourceBranch: 'feat/fix' },
    });
    expect(await core.watches.previewTarget('https://example.com/x', 'pages')).toMatchObject({ kind: 'free', preview: null });
  });

  test('caches the GitLab user in meta across cores', async () => {
    const { core, clock, gitlab, open } = setup();
    const id = insertWatch(core.db, { kind: 'mr', targetUrl: MR_URL, normalizedTarget: 'gitlab:gitlab.example.com/g/p!7' });
    core.db.prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(clock.now() - 1, id);

    await core.scheduler.tick();
    expect(gitlab.me).toHaveBeenCalledOnce();
    const row = core.db.prepare("SELECT value FROM meta WHERE key = 'gitlab_me:corp'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ id: 42, username: 'me' });

    const second = open();
    cleanups.unshift(() => second.close());
    core.db.prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(clock.now() - 1, id);
    await second.scheduler.tick();
    expect(gitlab.me).toHaveBeenCalledOnce();
  });

  test('exposes read models over the core database and clock', () => {
    const { core, clock } = setup();
    const id = insertWatch(core.db, { kind: 'mr' });
    core.db.prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(clock.now() + 9 * 60_000, id);

    expect(core.read.watchList({}).rows[0]!.nextCheck).toEqual({ kind: 'in', text: 'in 9m' });
    expect(core.read.navCounts()).toEqual({ watches: 1, queued: 0 });
  });
});
