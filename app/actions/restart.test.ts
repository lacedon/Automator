import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const requestHeaders = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ headers: requestHeaders }));

const { requestApplicationRestart } = await import('./restart');

type RestartMessage = { type: 'restart'; requestId: string };
type Supervisor = EventEmitter & { send?: (message: RestartMessage) => boolean };

const originalProcess = process;
let supervisor: Supervisor;

beforeEach(() => {
  supervisor = new EventEmitter();
  vi.stubGlobal('process', supervisor);
  requestHeaders.mockResolvedValue(new Headers({ host: 'localhost:4317' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('process', originalProcess);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('requests restart and accepts only its matching acceptance acknowledgement', async () => {
  const send = vi.fn((message: RestartMessage) => {
    queueMicrotask(() => {
      supervisor.emit('message', { type: 'restart-accepted', requestId: 'another-request' });
      supervisor.emit('message', { type: 'restart-accepted', requestId: message.requestId });
    });
    return true;
  });
  supervisor.send = send;

  const result = await requestApplicationRestart();

  expect(send.mock.calls[0]?.[0]).toEqual({ type: 'restart', requestId: expect.any(String) });
  expect(result).toEqual({ ok: true, value: { accepted: true } });
  expect(supervisor.listenerCount('message')).toBe(0);
  expect(supervisor.listenerCount('disconnect')).toBe(0);
});

test('reports a matching restart rejection', async () => {
  supervisor.send = vi.fn((message) => {
    queueMicrotask(() => supervisor.emit('message', { type: 'restart-rejected', requestId: message.requestId }));
    return true;
  });

  expect(await requestApplicationRestart()).toMatchObject({
    ok: false,
    error: { code: 'RESTART_FAILED', message: expect.stringContaining('rejected') },
  });
});

test('reports when the supervisor IPC channel is unavailable', async () => {
  expect(await requestApplicationRestart()).toMatchObject({
    ok: false,
    error: { code: 'RESTART_FAILED', message: expect.stringContaining('IPC') },
  });
});

test('reports when the supervisor does not acknowledge the restart request', async () => {
  vi.useFakeTimers();
  supervisor.send = vi.fn(() => true);

  const result = requestApplicationRestart();
  await vi.advanceTimersByTimeAsync(5_000);

  expect(await result).toMatchObject({
    ok: false,
    error: { code: 'RESTART_FAILED', message: expect.stringContaining('acknowledge') },
  });
});

test.each([
  ['Host', { host: 'example.com' }],
  ['X-Forwarded-Host', { host: 'localhost:4317', 'x-forwarded-host': 'example.com' }],
])('rejects a non-loopback %s header', async (_header, values) => {
  requestHeaders.mockResolvedValue(new Headers(values));
  const send = vi.fn(() => true);
  supervisor.send = send;

  expect(await requestApplicationRestart()).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'request' },
  });
  expect(send).not.toHaveBeenCalled();
});
