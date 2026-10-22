import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';
import { createCore, type Core } from '@core/index';
import { runCli } from './main';

const MR = 'https://gitlab.example.com/team/app/-/merge_requests/42';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const config = testConfig();
  const core = createCore(config, { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } });
  cleanups.push(() => {
    core.close();
    fs.rmSync(config.configDir, { recursive: true, force: true });
  });
  return core;
}

async function cli(core: Core, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, core);
  return { code, out, err };
}

function queuedRuns(core: Core) {
  return core.db
    .prepare("SELECT watch_id, repository, adhoc_prompt, extra_instructions, review_unresolved FROM runs WHERE status = 'queued'")
    .all();
}

describe('runCli', () => {
  test('watch add success exits 0', async () => {
    const core = setup();
    const r = await cli(core, 'watch', 'add', MR, '--repo', 'pages', '--interval', '30m', '--model', 'm1', '--initial-review', 'unresolved');
    expect(r).toEqual({ code: 0, out: ['Watch #1 created (mr, pages)'], err: [] });
    expect(core.watches.get(1)).toMatchObject({ intervalMs: 30 * 60_000, model: 'm1', initialReview: 'unresolved' });
  });

  test('unknown repository exits 1 and prints result file path', async () => {
    const core = setup();
    const r = await cli(core, 'watch', 'add', MR, '--repo', 'nope');
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    const [file] = fs.readdirSync(core.dataDir.attemptsDir);
    const attemptFile = path.join(core.dataDir.attemptsDir, file!);
    expect(r.err).toEqual([`Unknown Repository "nope". No Watch was created. Known: api, pages. Result file: ${attemptFile}`]);
    expect(core.watches.list()).toEqual([]);
  });

  test('unknown repository reports result file write failure', async () => {
    const core = setup();
    fs.writeFileSync(core.dataDir.attemptsDir, 'not a dir');
    const r = await cli(core, 'watch', 'add', MR, '--repo', 'nope');
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      expect.stringMatching(/^Unknown Repository "nope"\. No Watch was created\. Known: api, pages\. Result file could not be written: .+/),
    ]);
  });

  test('duplicate exits 1', async () => {
    const core = setup();
    await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    const r = await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    expect(r).toEqual({ code: 1, out: [], err: ['Already watched: Watch #1 (active, every 15m)'] });
  });

  test('missing --repo exits 2', async () => {
    const core = setup();
    const r = await cli(core, 'watch', 'add', MR);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('--repo');
    expect(core.watches.list()).toEqual([]);
  });

  test('invalid --interval exits 2 with message', async () => {
    const core = setup();
    const r = await cli(core, 'watch', 'add', MR, '--repo', 'pages', '--interval', '5x');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('Invalid duration: 5x');
    expect(core.watches.list()).toEqual([]);
  });

  test('free-form watch without instructions exits 1', async () => {
    const core = setup();
    const r = await cli(core, 'watch', 'add', 'https://example.com/page', '--repo', 'pages');
    expect(r).toEqual({ code: 1, out: [], err: ['Free-form Watches need --instructions'] });
  });

  test('run queues adhoc and prints position', async () => {
    const core = setup();
    await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    core.watches.runNow(1, {});
    const r = await cli(core, 'run', '--repo', 'api', '--prompt', 'Do the thing');
    expect(r).toEqual({ code: 0, out: ['Run #2 queued (position 2)'], err: [] });
    expect(queuedRuns(core)).toContainEqual(
      expect.objectContaining({ watch_id: null, repository: 'api', adhoc_prompt: 'Do the thing' }),
    );
    expect(core.db.prepare('SELECT model FROM runs WHERE id = 2').get()).toEqual({ model: core.config.runs.defaultModel });
  });

  test('unknown repository for run exits 1', async () => {
    const core = setup();
    const r = await cli(core, 'run', '--repo', 'nope', '--prompt', 'x');
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      expect.stringMatching(/^Unknown Repository "nope"\. No Run was queued\. Known: api, pages\. Result file: .+\.json$/),
    ]);
    expect(queuedRuns(core)).toEqual([]);
  });

  test('run-now with --review-unresolved', async () => {
    const core = setup();
    await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    const r = await cli(core, 'run-now', '1', '--review-unresolved', '--instructions', 'Look at the tests');
    expect(r).toEqual({ code: 0, out: ['Run #1 queued (position 1)'], err: [] });
    expect(queuedRuns(core)).toEqual([
      { watch_id: 1, repository: 'pages', adhoc_prompt: null, extra_instructions: 'Look at the tests', review_unresolved: 1 },
    ]);
  });

  test('run-now on unknown watch exits 1', async () => {
    const core = setup();
    const r = await cli(core, 'run-now', '9');
    expect(r).toEqual({ code: 1, out: [], err: ['Watch #9 not found'] });
  });

  test("watch rm while running exits 1 'Cancel the running Run first'", async () => {
    const core = setup();
    await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    core.watches.runNow(1, {});
    core.queue.claimNext();
    const r = await cli(core, 'watch', 'rm', '1');
    expect(r).toEqual({ code: 1, out: [], err: ['Cancel the running Run first'] });
    expect(core.watches.get(1)).not.toBeNull();
  });

  test('watch rm deletes', async () => {
    const core = setup();
    await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    const r = await cli(core, 'watch', 'rm', '1');
    expect(r).toEqual({ code: 0, out: ['Watch #1 deleted'], err: [] });
    expect(core.watches.get(1)).toBeNull();
  });

  test('watch list filters by state', async () => {
    const core = setup();
    await cli(core, 'watch', 'add', MR, '--repo', 'pages');
    await cli(core, 'watch', 'add', 'https://example.com/page', '--repo', 'api', '--instructions', 'Check it', '--interval', '1h');
    core.watches.pause(1);
    const all = await cli(core, 'watch', 'list');
    expect(all.code).toBe(0);
    expect(all.out).toHaveLength(3);
    expect(all.out[0]).toMatch(/^ID\s+STATE\s+KIND\s+REPOSITORY\s+EVERY\s+TARGET$/);
    const active = await cli(core, 'watch', 'list', '--state', 'active');
    expect(active.out).toHaveLength(2);
    expect(active.out[1]!.split(/\s+/)).toEqual(['2', 'active', 'free', 'api', '1h', 'https://example.com/page']);
    const paused = await cli(core, 'watch', 'list', '--state', 'paused', '--repo', 'pages');
    expect(paused.out[1]!.split(/\s+/)).toEqual(['1', 'paused', 'mr', 'pages', '15m', MR]);
  });

  test('@file instructions are read', async () => {
    const core = setup();
    const file = path.join(core.config.configDir, 'instructions.md');
    fs.writeFileSync(file, 'Summarize new posts\n');
    const r = await cli(core, 'watch', 'add', 'https://example.com/page', '--repo', 'pages', '--instructions', `@${file}`);
    expect(r).toEqual({ code: 0, out: ['Watch #1 created (free, pages)'], err: [] });
    expect(core.watches.get(1)!.instructions).toBe('Summarize new posts');
  });

  test('unreadable @file exits 2', async () => {
    const core = setup();
    const r = await cli(core, 'run', '--repo', 'pages', '--prompt', '@/does/not/exist.md');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('/does/not/exist.md');
    expect(queuedRuns(core)).toEqual([]);
  });
});
