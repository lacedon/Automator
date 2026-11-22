import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { createJsonRpcPeer, JsonRpcError } from './jsonRpc';

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
