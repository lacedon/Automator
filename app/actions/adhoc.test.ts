import fs from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath }));

const { queueAdhoc, deleteAdhocRun } = await import('./adhoc');

let core: Core;

beforeEach(() => {
  core = createCore(
    testConfig({ runs: { defaultModel: 'default-model', models: ['other-model'] }, jira: { enabled: true } }),
    {
      clock: fakeClock(),
      notifier: { async notifyNeedsYou() {} },
      jira: () => ({
        async issue(key: string) {
          if (key === 'ABC-500') throw new Error('Jira is down');
          return { key, summary: `Summary of ${key}` } as never;
        },
        async myself() {
          return { accountId: 'me' };
        },
        async statuses() {
          return [];
        },
      }),
    },
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

const queuedRuns = () =>
  core.db.prepare("SELECT repository, adhoc_prompt AS prompt, model FROM runs WHERE status = 'queued'").all();

test('queueAdhoc reports an unknown Repository with the attempt file and queues nothing', async () => {
  const fields = { repository: 'nope', prompt: 'Update CHANGELOG', model: '' };
  const result = await queueAdhoc(null, form(fields));
  expect(result).toEqual({
    ok: false,
    error: { code: 'UNKNOWN_REPOSITORY', name: 'nope', known: ['api', 'pages'], attemptFile: expect.any(String) },
    values: fields,
  });
  if (result?.ok !== false || result.error.code !== 'UNKNOWN_REPOSITORY') throw new Error('unexpected');
  expect(fs.existsSync(result.error.attemptFile!)).toBe(true);
  expect(queuedRuns()).toEqual([]);
});

test('queueAdhoc queues the Run and reports its number and position', async () => {
  core.queue.enqueueAdhoc({ repository: 'api', prompt: 'first', model: 'm' });
  const result = await queueAdhoc(null, form({ repository: 'pages', prompt: '  Update CHANGELOG  ', model: '' }));
  expect(result).toEqual({ ok: true, value: { runId: 2, position: 2 } });
  expect(queuedRuns()).toEqual([
    { repository: 'api', prompt: 'first', model: 'm' },
    { repository: 'pages', prompt: 'Update CHANGELOG', model: 'default-model' },
  ]);
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');

  expect(await queueAdhoc(null, form({ repository: 'pages', prompt: 'p', model: 'other-model' }))).toMatchObject({
    ok: true,
  });
  expect(queuedRuns()).toContainEqual({ repository: 'pages', prompt: 'p', model: 'other-model' });
});

test('queueAdhoc requires a prompt', async () => {
  const fields = { repository: 'pages', prompt: '   ', model: '' };
  expect(await queueAdhoc(null, form(fields))).toEqual({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'prompt', message: 'Prompt is required' },
    values: fields,
  });
  expect(queuedRuns()).toEqual([]);
});

const queuedTickets = () =>
  core.db
    .prepare(
      "SELECT ticket_key AS key, ticket_title AS title, adhoc_prompt AS prompt FROM runs WHERE status = 'queued'",
    )
    .all();

test('queueAdhoc links a Ticket given as a key and stores its fetched title', async () => {
  const result = await queueAdhoc(
    null,
    form({ repository: 'pages', prompt: 'Use the helper', model: '', ticket: ' abc-123 ' }),
  );
  expect(result).toEqual({ ok: true, value: { runId: 1, position: 1 } });
  expect(queuedTickets()).toEqual([{ key: 'ABC-123', title: 'Summary of ABC-123', prompt: 'Use the helper' }]);
});

test('queueAdhoc takes a blank prompt when a Ticket is linked', async () => {
  const result = await queueAdhoc(null, form({ repository: 'pages', prompt: '', model: '', ticket: 'ABC-1' }));
  expect(result).toMatchObject({ ok: true });
  expect(queuedTickets()).toEqual([{ key: 'ABC-1', title: 'Summary of ABC-1', prompt: null }]);
});

test('queueAdhoc still queues and warns when the Ticket title cannot be fetched', async () => {
  const result = await queueAdhoc(null, form({ repository: 'pages', prompt: 'p', model: '', ticket: 'ABC-500' }));
  expect(result).toEqual({
    ok: true,
    value: { runId: 1, position: 1, warning: 'Could not fetch the Ticket title: Jira is down' },
  });
  expect(queuedTickets()).toEqual([{ key: 'ABC-500', title: null, prompt: 'p' }]);
});

test('queueAdhoc rejects an invalid Ticket, keeps the entered values and queues nothing', async () => {
  const fields = { repository: 'pages', prompt: 'p', model: '', ticket: 'nonsense' };
  const result = await queueAdhoc(null, form(fields));
  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'ticket' }, values: fields });
  expect(queuedRuns()).toEqual([]);
});

test('deleteAdhocRun refuses unfinished Runs and deletes finished ones', async () => {
  const run = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'p', model: 'm' });
  expect(await deleteAdhocRun(run.id)).toEqual({
    ok: false,
    error: { code: 'INVALID_STATE', state: 'queued', action: 'deleteAdhoc' },
  });
  core.db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(run.id);
  expect(await deleteAdhocRun(run.id)).toEqual({ ok: true });
  expect(core.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});
