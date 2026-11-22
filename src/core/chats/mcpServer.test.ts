import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { serveMcp, type McpTool } from './mcpServer';

function connect(tools: McpTool[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = serveMcp(input, output, tools);
  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
    }
  });
  const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
  const reply = async (id: number) => {
    for (let i = 0; i < 200; i += 1) {
      const found = lines.find((line) => line.id === id);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`no reply to ${id}`);
  };
  return { input, send, reply, lines, server };
}

const echo: McpTool = {
  definition: {
    name: 'echo',
    description: 'Echoes',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  async call(args) {
    return { content: [{ type: 'text', text: JSON.stringify(args) }] };
  },
};

describe('serveMcp', () => {
  test('initialize/tools/list/tools/call framing', async () => {
    const c = connect([echo]);
    c.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    expect(await c.reply(1)).toMatchObject({
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'automator' } },
    });
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(await c.reply(2)).toMatchObject({ result: { tools: [echo.definition] } });
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
    expect(await c.reply(3)).toMatchObject({ result: { content: [{ type: 'text', text: '{"text":"hi"}' }] } });
    c.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(await c.reply(4)).toMatchObject({ result: {} });
  });

  test('tools/call for an unknown tool is a JSON-RPC error', async () => {
    const c = connect([echo]);
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    expect(await c.reply(1)).toMatchObject({ error: { code: -32602 } });
    c.send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(await c.reply(2)).toMatchObject({ error: { code: -32601 } });
  });

  test('a tool that throws becomes an isError result', async () => {
    const c = connect([
      {
        definition: { name: 'boom', description: 'x', inputSchema: { type: 'object' } },
        call: () => Promise.reject(new Error('kaput')),
      },
    ]);
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    expect(await c.reply(1)).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('kaput') }] },
    });
  });

  test('progress notifications are sent while waiting', async () => {
    let release!: () => void;
    const slow: McpTool = {
      definition: { name: 'slow', description: 'x', inputSchema: { type: 'object' } },
      async call(_args, progress) {
        progress('waiting 1');
        progress('waiting 2');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    };
    const c = connect([slow]);
    c.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slow', arguments: {}, _meta: { progressToken: 'tok' } },
    });
    for (let i = 0; i < 200 && c.lines.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(c.lines.map((line) => line.method)).toEqual(['notifications/progress', 'notifications/progress']);
    expect(c.lines[1]).toMatchObject({ params: { progressToken: 'tok', progress: 2, message: 'waiting 2' } });
    release();
    expect(await c.reply(1)).toMatchObject({ result: { content: [{ text: 'done' }] } });
  });

  test('no progress is sent when the client gave no progress token, and the signal aborts when the input ends', async () => {
    let signal: AbortSignal | undefined;
    const tool: McpTool = {
      definition: { name: 't', description: 'x', inputSchema: { type: 'object' } },
      call(_args, progress, abort) {
        progress('ignored');
        signal = abort;
        return new Promise(() => {});
      },
    };
    const c = connect([tool]);
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } });
    for (let i = 0; i < 200 && signal === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(c.lines).toEqual([]);
    c.input.end();
    await c.server.closed;
    expect(signal?.aborted).toBe(true);
  });

  test('a failing output stream (EPIPE) does not throw', () => {
    const output = new PassThrough();
    serveMcp(new PassThrough(), output, [echo]);
    expect(() => output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });

  test('notifications/cancelled aborts only that request', async () => {
    const signals = new Map<string, AbortSignal>();
    const tool: McpTool = {
      definition: { name: 't', description: 'x', inputSchema: { type: 'object' } },
      call(args, _progress, signal) {
        signals.set((args as { n: string }).n, signal);
        return new Promise(() => {});
      },
    };
    const c = connect([tool]);
    c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 't', arguments: { n: 'a' } } });
    c.send({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 't', arguments: { n: 'b' } } });
    for (let i = 0; i < 200 && signals.size < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } });
    for (let i = 0; i < 200 && !signals.get('a')!.aborted; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(signals.get('a')!.aborted).toBe(true);
    expect(signals.get('b')!.aborted).toBe(false);
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'unknown' } }); // ignored
  });

  test('a failing stdout (EPIPE) closes the server instead of throwing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = serveMcp(input, output, []);
    expect(() => output.emit('error', new Error('write EPIPE'))).not.toThrow();
    await server.closed;
  });
});
