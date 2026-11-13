import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('../lib/guard', async () => (await import('../lib/guard.mock')).allowAll);
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { sendRunMessage, branchRun } = await import('./chat');

let core: Core;

beforeEach(() => {
  const config = testConfig();
  core = createCore(
    config,
    { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } },
    { repositories: config.repositories },
  );
  holder.core = core;
  revalidatePath.mockClear();
});

afterEach(() => core.close());

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

function finishedAdhoc() {
  const run = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'first', model: 'm' });
  core.db.prepare("UPDATE runs SET status = 'finished', session_id = 'sess-1' WHERE id = ?").run(run.id);
  return run;
}

test('queues a follow-up and revalidates', async () => {
  const parent = finishedAdhoc();

  const result = await sendRunMessage(null, form({ runId: String(parent.id), message: ' and now this ' }));

  expect(result).toEqual({ ok: true, value: { runId: parent.id + 1 } });
  expect(
    core.db
      .prepare('SELECT status, adhoc_prompt AS prompt, parent_run_id AS parent FROM runs WHERE id = ?')
      .get(parent.id + 1),
  ).toEqual({ status: 'queued', prompt: 'and now this', parent: parent.id });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test.each(['abc', '0', '-1', '1.5', ''])('returns INVALID_INPUT for the runId %j', async (runId) => {
  const fields = { runId, message: 'hi' };

  expect(await sendRunMessage(null, form(fields))).toEqual({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'runId', message: expect.any(String) },
    values: { message: 'hi' },
  });
  expect(revalidatePath).not.toHaveBeenCalled();
});

test('echoes the message when the queue rejects it', async () => {
  const parent = finishedAdhoc();

  const result = await sendRunMessage(null, form({ runId: String(parent.id), message: '   ' }));

  expect(result).toEqual({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'message', message: 'Message is required' },
    values: { message: '   ' },
  });
  expect(core.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(revalidatePath).not.toHaveBeenCalled();
});

test('branchRun creates a new chat from a finished Run and redirects to it', async () => {
  const run = finishedAdhoc();
  await expect(branchRun(null, form({ runId: String(run.id), message: 'other way' }))).rejects.toThrow(
    /REDIRECT:\/runs\/\d+/,
  );
  const branch = core.db.prepare('SELECT * FROM runs WHERE branched_from_run_id = ?').get(run.id) as {
    parent_run_id: number | null;
    session_id: string | null;
    adhoc_prompt: string;
  };
  expect(branch).toMatchObject({ parent_run_id: null, session_id: null, adhoc_prompt: 'other way' });
});

test('branchRun reports an unfinished Run', async () => {
  const run = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'first', model: 'm' });
  const result = await branchRun(null, form({ runId: String(run.id), message: 'x' }));
  expect(result).toMatchObject({ ok: false, values: { message: 'x' } });
});
