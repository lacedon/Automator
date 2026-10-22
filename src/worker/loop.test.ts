import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';
import {
  acquireWorkerLock,
  createCore,
  type CopilotExit,
  type CopilotLauncher,
  type NeedsYouEvent,
  type Outcome,
  type RunStatus,
} from '@core/index';
import { WorkerLoop } from './loop';

const DAY = 86_400_000;
const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type FakeProc = { runDir: string; finish(outcome?: Outcome): void };

// In-memory Copilot: each start() stays running until the test calls finish().
function fakeCopilot() {
  const procs: FakeProc[] = [];
  const launcher: CopilotLauncher = {
    start(opts) {
      let resolve!: (exit: CopilotExit) => void;
      const exited = new Promise<CopilotExit>((r) => (resolve = r));
      const runDir = path.dirname(opts.transcriptPath);
      procs.push({
        runDir,
        finish(outcome = 'nothing') {
          fs.writeFileSync(path.join(runDir, 'copilot-result.json'), JSON.stringify({ outcome, summary: outcome }));
          resolve({ code: 0, signal: null });
        },
      });
      return { pid: 0, exited, kill: () => resolve({ code: null, signal: 'SIGTERM' }) };
    },
  };
  return { launcher, procs };
}

function setup(opts: { onLockLost?: () => void } = {}) {
  const config = testConfig({ prompts: { dir: path.resolve('prompts') } });
  const clock = fakeClock();
  const copilot = fakeCopilot();
  const notified: NeedsYouEvent[] = [];
  const core = createCore(config, {
    clock,
    copilot: copilot.launcher,
    notifier: {
      async notifyNeedsYou(e) {
        notified.push(e);
      },
    },
  });
  acquireWorkerLock(core.db, clock, process.pid, () => false);
  const loop = new WorkerLoop(core, opts);
  cleanups.push(() => {
    core.close();
    fs.rmSync(config.configDir, { recursive: true, force: true });
  });
  const status = (id: number) =>
    (core.db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: RunStatus } | undefined)?.status;
  const adhoc = () => core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'Do the thing', model: 'm1' }).id;
  return { core, clock, loop, procs: copilot.procs, notified, status, adhoc };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WorkerLoop', () => {
  test('iterate claims and runs one queued run at a time', async () => {
    const { core, loop, procs, status, adhoc } = setup();
    const a = adhoc();
    const b = adhoc();

    await loop.iterate();
    expect(status(a)).toBe('running');
    expect(status(b)).toBe('queued');
    await waitFor(() => procs.length === 1);

    await loop.iterate();
    expect(status(b)).toBe('queued');
    expect(procs).toHaveLength(1);

    procs[0]!.finish();
    await waitFor(() => status(a) === 'finished' && !core.executor.isBusy());
    await loop.iterate();
    expect(status(b)).toBe('running');
    await waitFor(() => procs.length === 2);
    procs[1]!.finish();
    await loop.stop();
    expect(status(b)).toBe('finished');
  });

  test('scheduler runs on first iterate and then every 30 s', async () => {
    const { core, clock, loop } = setup();
    const tick = vi.spyOn(core.scheduler, 'tick');

    await loop.iterate();
    expect(tick).toHaveBeenCalledTimes(1);
    clock.advance(10_000);
    await loop.iterate();
    clock.advance(19_000);
    await loop.iterate();
    expect(tick).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    await loop.iterate();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  test('cleanup runs when due', async () => {
    const { core, clock, loop } = setup();
    const run = vi.spyOn(core.cleanup, 'run');

    await loop.iterate();
    expect(run).toHaveBeenCalledTimes(1);
    clock.advance(DAY);
    await loop.iterate();
    expect(run).toHaveBeenCalledTimes(1);
    clock.advance(6 * DAY);
    await loop.iterate();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('stop waits for the active run', async () => {
    const { loop, procs, status, adhoc } = setup();
    const a = adhoc();
    await loop.iterate();
    await waitFor(() => procs.length === 1);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    const b = adhoc();
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    expect(status(a)).toBe('running');

    procs[0]!.finish();
    await stopping;
    expect(status(a)).toBe('finished');
    await loop.iterate();
    expect(status(b)).toBe('queued');
  });

  test('keeps iterating when the scheduler tick rejects', async () => {
    const { core, clock, loop, procs, status, adhoc } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(core.scheduler, 'tick').mockRejectedValue(new Error('boom'));

    await loop.iterate();
    await waitFor(() => errors.mock.calls.length > 0);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z .*boom/));
    const a = adhoc();
    clock.advance(30_000);
    await loop.iterate();
    expect(status(a)).toBe('running');
    await waitFor(() => procs.length === 1);
    procs[0]!.finish();
    await loop.stop();
  });

  test('needs-you outcome notifies through the injected notifier', async () => {
    const { core, loop, procs, notified } = setup();
    const watch = core.watches.create({
      target: 'https://example.com/status',
      repository: 'pages',
      instructions: 'Check it',
    });
    if (!watch.ok) throw new Error(JSON.stringify(watch.error));
    core.queue.enqueueWatch({
      watchId: watch.value.id,
      repository: 'pages',
      trigger: 'manual',
      reason: 'manual',
      model: 'm1',
    });

    await loop.iterate();
    await waitFor(() => procs.length === 1);
    procs[0]!.finish('needs-you');
    await loop.stop();
    expect(notified.map((e) => e.watchId)).toEqual([watch.value.id]);
  });

  test('a hanging scheduler tick does not stall heartbeat or watchdog', async () => {
    const { core, clock, loop } = setup();
    const tick = vi.spyOn(core.scheduler, 'tick').mockReturnValue(new Promise(() => {}));
    const watchdog = vi.spyOn(core.executor, 'watchdog');
    const heartbeatAt = () =>
      (core.db.prepare('SELECT heartbeat_at FROM worker_lock').get() as { heartbeat_at: number }).heartbeat_at;

    await loop.iterate();
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await loop.iterate();
      expect(heartbeatAt()).toBe(clock.now());
    }
    expect(watchdog).toHaveBeenCalledTimes(4);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  test('a lost lock stops claiming and reports it', async () => {
    const onLockLost = vi.fn();
    const { core, loop, status, adhoc } = setup({ onLockLost });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    core.db.prepare('UPDATE worker_lock SET pid = ?').run(process.pid + 1);
    const a = adhoc();

    await loop.iterate();
    await loop.iterate();
    expect(onLockLost).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/Z lost worker lock; exiting$/));
    expect(status(a)).toBe('queued');
  });
});
