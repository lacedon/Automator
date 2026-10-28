import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath }));

const { sendRunMessage } = await import('./chat');

let core: Core;

beforeEach(() => {
  core = createCore(testConfig(), { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } });
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
