import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';
import { insertWatch } from '../../test/helpers/db';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
);
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ redirect }));

const { pauseWatch, closeWatch, reopenWatch, deleteWatch, runWatchNow } = await import('./watches');

let core: Core;

beforeEach(() => {
  core = createCore(testConfig(), { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } });
  holder.core = core;
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterEach(() => core.close());

const stateOf = (id: number) => core.watches.get(id)?.state;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

type QueuedRun = { watchId: number; trigger: string; extraInstructions: string | null; reviewUnresolved: number };

function queued(): QueuedRun[] {
  return core.db
    .prepare(
      `SELECT watch_id AS watchId, trigger, extra_instructions AS extraInstructions, review_unresolved AS reviewUnresolved
       FROM runs WHERE status = 'queued'`,
    )
    .all() as QueuedRun[];
}

test('pauseWatch pauses an active Watch and revalidates the layout', async () => {
  const id = insertWatch(core.db);
  expect(await pauseWatch(id)).toEqual({ ok: true });
  expect(stateOf(id)).toBe('paused');
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('pauseWatch returns domain errors instead of throwing', async () => {
  const closed = insertWatch(core.db, { state: 'closed' });
  expect(await pauseWatch(closed)).toEqual({ ok: false, error: { code: 'INVALID_STATE', state: 'closed', action: 'pause' } });
  expect(await pauseWatch(99_999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await pauseWatch(-1)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});

test('closeWatch closes and reopenWatch reopens', async () => {
  const id = insertWatch(core.db);
  expect(await closeWatch(id)).toEqual({ ok: true });
  expect(stateOf(id)).toBe('closed');
  expect(await reopenWatch(id)).toEqual({ ok: true });
  expect(stateOf(id)).toBe('active');
  expect(revalidatePath).toHaveBeenCalledTimes(2);
});

test('reopenWatch reports a duplicate open Watch', async () => {
  const closed = insertWatch(core.db, { state: 'closed', normalizedTarget: 'gitlab:x!1' });
  insertWatch(core.db, { normalizedTarget: 'gitlab:x!1' });
  expect(await reopenWatch(closed)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_WATCH' } });
});

test('deleteWatch deletes and redirects to /watches', async () => {
  const id = insertWatch(core.db);
  await expect(deleteWatch(id)).rejects.toThrow('NEXT_REDIRECT /watches');
  expect(core.watches.get(id)).toBeNull();
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  expect(redirect).toHaveBeenCalledWith('/watches');
});

test('deleteWatch refuses while a Run is in progress', async () => {
  const id = insertWatch(core.db);
  const run = core.watches.runNow(id, {});
  if (!run.ok) throw new Error('enqueue failed');
  core.db.prepare("UPDATE runs SET status = 'running', started_at = 1 WHERE id = ?").run(run.value.id);
  expect(await deleteWatch(id)).toEqual({ ok: false, error: { code: 'RUN_IN_PROGRESS', runId: run.value.id } });
  expect(redirect).not.toHaveBeenCalled();
});

test('runWatchNow queues a manual Run with extra instructions and the review flag', async () => {
  const id = insertWatch(core.db);
  const result = await runWatchNow(null, form({ id: String(id), extraInstructions: 'Be brief', reviewUnresolved: 'on' }));
  expect(result).toMatchObject({ ok: true });
  const [run] = queued();
  expect(run).toMatchObject({ watchId: id, trigger: 'manual', extraInstructions: 'Be brief', reviewUnresolved: 1 });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('runWatchNow treats blank instructions and a missing checkbox as not set', async () => {
  const id = insertWatch(core.db);
  expect(await runWatchNow(null, form({ id: String(id), extraInstructions: '  ' }))).toMatchObject({ ok: true });
  expect(queued()[0]).toMatchObject({ extraInstructions: null, reviewUnresolved: 0 });
});

test('runWatchNow returns JIRA_DISABLED for Jira Watches when Jira is off', async () => {
  const id = insertWatch(core.db, { kind: 'jira', normalizedTarget: 'jira:PROJ-1' });
  expect(await runWatchNow(null, form({ id: String(id) }))).toEqual({ ok: false, error: { code: 'JIRA_DISABLED' } });
  expect(queued()).toEqual([]);
});
