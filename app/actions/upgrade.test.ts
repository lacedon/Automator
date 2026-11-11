import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const spawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('../lib/guard', async () => (await import('../lib/guard.mock')).allowAll);
vi.mock('node:child_process', () => ({ spawn }));

const { upgradeAndRestart } = await import('./upgrade');

let core: Core;
const child = () => Object.assign(new EventEmitter(), { unref: vi.fn() });

beforeEach(() => {
  core = createCore(testConfig(), { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } });
  holder.core = core;
  spawn.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  core.close();
});

test('starts the upgrade script detached and stops the supervisor afterwards', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const proc = child();
  spawn.mockImplementation(() => {
    queueMicrotask(() => proc.emit('spawn'));
    return proc;
  });

  expect(await upgradeAndRestart()).toEqual({ ok: true });

  expect(spawn).toHaveBeenCalledWith(
    'npm',
    ['run', 'upgrade-and-restart'],
    expect.objectContaining({ detached: true }),
  );
  expect(proc.unref).toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(kill).toHaveBeenCalledWith(process.ppid, 'SIGTERM');
});

test('rejects while Runs are queued or running', async () => {
  core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'a', model: 'm' });

  expect(await upgradeAndRestart()).toMatchObject({
    ok: false,
    error: { code: 'UPGRADE_FAILED', message: expect.stringContaining('1 Run is active or queued') },
  });
  expect(spawn).not.toHaveBeenCalled();
});

test('reports a script that cannot be started without stopping the supervisor', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  spawn.mockImplementation(() => {
    const proc = child();
    queueMicrotask(() => proc.emit('error', new Error('spawn npm ENOENT')));
    return proc;
  });

  expect(await upgradeAndRestart()).toMatchObject({ ok: false, error: { code: 'UPGRADE_FAILED' } });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(kill).not.toHaveBeenCalled();
});
