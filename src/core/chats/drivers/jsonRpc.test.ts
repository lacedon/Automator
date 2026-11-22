import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { createJsonRpcPeer, JsonRpcError, JsonRpcTimeoutError } from './jsonRpc';

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  const sent: unknown[] = [];
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line !== '') sent.push(JSON.parse(line));
  });
  const peer = createJsonRpcPeer(input, output, (line) => lines.push(line));
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { input, output, peer, lines, sent, tick };
}

describe('createJsonRpcPeer limits', () => {
  test('an oversized line is dropped and logged, and the next line still works', async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const peer = createJsonRpcPeer(input, new PassThrough(), (line) => lines.push(line), { maxLineChars: 100 });
    const seen: unknown[] = [];
    peer.onNotification('ping', (params) => seen.push(params));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { text: 'x'.repeat(500) } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: 1 })}\n`);
    await tick();
    expect(seen).toEqual([1]);
    expect(lines.some((line) => /oversized/.test(line))).toBe(true);
    expect(lines.every((line) => line.length < 200)).toBe(true); // the dropped line is not logged
  });

  test('a request that gets no response times out and is forgotten', async () => {
    const { input, peer, tick } = setup();
    const slow = peer.request('slow', {}, { timeoutMs: 20 });
    await expect(slow).rejects.toBeInstanceOf(JsonRpcTimeoutError);
    // A late response for the forgotten request is ignored.
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'late' })}\n`);
    await tick();
    const next = peer.request<string>('next', {});
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'ok' })}\n`);
    expect(await next).toBe('ok');
  });

  test('a write error closes the peer and rejects pending requests instead of crashing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    const peer = createJsonRpcPeer(input, output, (line) => lines.push(line));
    const pending = peer.request('a', {});
    output.emit('error', new Error('EPIPE'));
    await expect(pending).rejects.toThrow('closed');
    expect(peer.closedNow()).toBe(true);
    expect(lines.some((line) => /EPIPE/.test(line))).toBe(true);
  });

  test('an output that stops draining fails the peer once its buffer is too large', async () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 16 }); // nobody reads it
    const peer = createJsonRpcPeer(input, output, () => {}, { maxWriteBuffer: 1024 });
    const first = peer.request('a', { text: 'x'.repeat(5000) });
    const second = peer.request('b', {});
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(peer.closedNow()).toBe(true);
  });
});

describe('createJsonRpcPeer', () => {
  test('frames newline-delimited messages split across chunks', async () => {
    const { input, peer, tick } = setup();
    const seen: unknown[] = [];
    peer.onNotification('ping', (params) => seen.push(params));
    const message = JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { text: 'héllo' } });
    const bytes = Buffer.from(`${message}\n${message}\n`);
    // Split inside the multibyte character and inside the newline-separated pair.
    const cut = bytes.indexOf(0xc3) + 1;
    input.write(bytes.subarray(0, cut));
    await tick();
    expect(seen).toEqual([]);
    input.write(bytes.subarray(cut));
    await tick();
    expect(seen).toEqual([{ text: 'héllo' }, { text: 'héllo' }]);
  });

  test('correlates responses by id including out-of-order', async () => {
    const { input, peer, sent, tick } = setup();
    const first = peer.request<string>('a', {});
    const second = peer.request<string>('b', {});
    await tick();
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'a', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'b', params: {} },
    ]);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'two' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'one' })}\n`);
    expect(await Promise.all([first, second])).toEqual(['one', 'two']);
  });

  test('rejects pending requests with the error object', async () => {
    const { input, peer } = setup();
    const pending = peer.request('a', {});
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Resource not found', data: { id: 'x' } } })}\n`,
    );
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).toMatchObject({ code: -32002, message: 'Resource not found', data: { id: 'x' } });
  });

  test('dispatches agent-to-client requests and replies with the handler result or a JSON-RPC error', async () => {
    const { input, peer, sent, tick } = setup();
    peer.onRequest('session/request_permission', (params) => ({ got: params }));
    peer.onRequest('boom', () => {
      throw new Error('handler failed');
    });
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { a: 1 } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'boom' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'unknown/method' })}\n`);
    await tick();
    await tick();
    expect((sent as { id: number }[]).sort((a, b) => a.id - b.id)).toEqual([
      { jsonrpc: '2.0', id: 7, result: { got: { a: 1 } } },
      { jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'handler failed' } },
      { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found: unknown/method' } },
    ]);
  });

  test('a malformed line is logged and does not crash the peer', async () => {
    const { input, peer, lines, tick } = setup();
    const seen: unknown[] = [];
    peer.onNotification('ok', (params) => seen.push(params));
    input.write('this is not json\n');
    input.write('[1,2]\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ok', params: 1 })}\n`);
    await tick();
    expect(seen).toEqual([1]);
    expect(lines.some((line) => line.includes('malformed'))).toBe(true);
  });

  test('pending requests reject when the stream closes', async () => {
    const { input, peer } = setup();
    const pending = peer.request('a', {});
    input.end();
    await expect(pending).rejects.toThrow(/closed/);
    await expect(peer.request('b', {})).rejects.toThrow(/closed/);
    await peer.closed;
  });

  test('close rejects pending requests and ignores later input', async () => {
    const { input, peer } = setup();
    const pending = peer.request('a', {});
    peer.close();
    await expect(pending).rejects.toThrow(/closed/);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 })}\n`);
  });
});
