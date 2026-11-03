import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const requestHeaders = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ headers: requestHeaders }));

const { requestApplicationRestart } = await import('./restart');

type RestartMessage = { type: 'restart'; requestId: string };
type Supervisor = EventEmitter & {
  env: Record<string, string>;
  send?: (message: RestartMessage, callback?: (error: Error | null) => void) => boolean;
};

const originalProcess = process;
let supervisor: Supervisor;

beforeEach(() => {
  supervisor = Object.assign(new EventEmitter(), { env: {} });
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

test('waits for acknowledgement when IPC backpressure returns false', async () => {
  supervisor.send = vi.fn((message) => {
    queueMicrotask(() => supervisor.emit('message', { type: 'restart-accepted', requestId: message.requestId }));
    return false;
  });

  expect(await requestApplicationRestart()).toEqual({ ok: true, value: { accepted: true } });
});

test('uses the supervisor IPC socket inherited by Next dev server workers', async () => {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\automator-restart-test-${process.pid}-${randomUUID()}`
      : `.restart-dev-${process.pid}-${randomUUID().slice(0, 8)}.sock`;
  const server = createServer((connection) => {
    let input = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as RestartMessage;
      connection.end(`${JSON.stringify({ type: 'restart-accepted', requestId: request.requestId })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  supervisor.env.AUTOMATOR_SUPERVISOR_SOCKET = socketPath;
  supervisor.send = vi.fn(() => false);

  try {
    expect(await requestApplicationRestart()).toEqual({ ok: true, value: { accepted: true } });
    expect(supervisor.send).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
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
