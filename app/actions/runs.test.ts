import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';
import { insertWatch } from '../../test/helpers/db';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath }));

const { cancelQueued, closeWatchFromQueue } = await import('./runs');

let core: Core;

beforeEach(() => {
  core = createCore(testConfig(), { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } });
  holder.core = core;
  revalidatePath.mockClear();
});

afterEach(() => core.close());

const runIds = () => (core.db.prepare('SELECT id FROM runs ORDER BY id').all() as { id: number }[]).map((r) => r.id);

test('cancelQueued deletes a queued Run and refuses a running one', async () => {
  const running = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'a', model: 'm' });
  const queued = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'b', model: 'm' });
  core.queue.claimNext();

  expect(await cancelQueued(queued.id)).toEqual({ ok: true });
  expect(runIds()).toEqual([running.id]);
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  expect(await cancelQueued(running.id)).toEqual({
    ok: false,
    error: { code: 'INVALID_STATE', state: 'running', action: 'cancelQueued' },
  });
  expect(await cancelQueued(0)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});

test('closeWatchFromQueue closes the Watch and removes its queued request', async () => {
  const watchId = insertWatch(core.db);
  const other = insertWatch(core.db);
  core.queue.enqueueWatch({ watchId, repository: 'pages', trigger: 'schedule', reason: 'new comment', model: 'm' });
  const kept = core.queue.enqueueWatch({
    watchId: other,
    repository: 'pages',
    trigger: 'schedule',
    reason: 'x',
    model: 'm',
  });

  expect(await closeWatchFromQueue(watchId)).toEqual({ ok: true });
  expect(core.watches.get(watchId)?.state).toBe('closed');
  expect(runIds()).toEqual([kept.id]);
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  expect(await closeWatchFromQueue(watchId)).toEqual({
    ok: false,
    error: { code: 'INVALID_STATE', state: 'closed', action: 'close' },
  });
});
