import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('../lib/guard', async () => (await import('../lib/guard.mock')).allowAll);

const { POST: createAutomation } = await import('./automations/route');
const { POST: queueRun } = await import('./runs/route');
const { GET: getRun } = await import('./runs/[id]/route');

let core: Core;

beforeEach(() => {
  const config = testConfig({ providers: { copilot: { defaultModel: 'default-model', models: [] } } });
  core = createCore(
    config,
    { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } },
    { repositories: config.repositories },
  );
  holder.core = core;
});

afterEach(() => core.close());

const post = (handler: typeof queueRun, body: unknown) =>
  handler(
    new Request('http://x/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
  );
const poll = (id: string) => getRun(new Request('http://x/api'), { params: Promise.resolve({ id }) });

test('POST /api/runs answers 202 with a Run id that polls as pending, then finished', async () => {
  const res = await post(queueRun, { repository: 'api', prompt: 'Update CHANGELOG' });
  expect(res.status).toBe(202);
  const { runId } = await res.json();

  const pending = await poll(String(runId));
  expect(pending.status).toBe(202);
  expect(await pending.json()).toEqual({ runId, status: 'pending', error: null, result: null });

  core.db.prepare("UPDATE runs SET status = 'finished', outcome = 'acted', summary = 'Done' WHERE id = ?").run(runId);
  const finished = await poll(String(runId));
  expect(finished.status).toBe(200);
  expect(await finished.json()).toEqual({
    runId,
    status: 'finished',
    error: null,
    result: { outcome: 'acted', summary: 'Done', branch: null },
  });
});

test('a finished Run that failed reports the error and no result', async () => {
  const { runId } = await (await post(queueRun, { repository: 'api', prompt: 'p' })).json();
  core.db
    .prepare("UPDATE runs SET status = 'finished', result_status = 'error', error_json = ? WHERE id = ?")
    .run(JSON.stringify({ code: 'BOOM', message: 'It broke' }), runId);
  expect(await (await poll(String(runId))).json()).toMatchObject({
    status: 'finished',
    error: { code: 'BOOM', message: 'It broke' },
    result: null,
  });
});

test('errors carry a matching HTTP status and a code and message', async () => {
  const unknown = await post(queueRun, { repository: 'nope', prompt: 'p' });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({
    error: { code: 'UNKNOWN_REPOSITORY', message: expect.stringContaining('Unknown Repository "nope"') },
  });

  const malformed = await post(queueRun, 'not json');
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.code).toBe('INVALID_INPUT');

  const missing = await poll('999');
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.code).toBe('NOT_FOUND');
});

test('POST /api/automations creates an Automation and rejects a duplicate with 409', async () => {
  const body = {
    target: 'https://example.com/some/page',
    repository: 'api',
    instructions: 'Watch it',
    interval: '30m',
  };
  const created = await post(createAutomation, body);
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ automationId: 1, kind: 'free', repository: 'api' });

  const duplicate = await post(createAutomation, body);
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error.code).toBe('DUPLICATE_WATCH');

  const badInterval = await post(createAutomation, { ...body, interval: 'soon' });
  expect(badInterval.status).toBe(400);
});
