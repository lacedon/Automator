import { createJsonRpcPeer, JsonRpcError } from './drivers/jsonRpc';
import type { ToolResult } from './chatToolDefs';

// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), written by hand: initialize, tools/list, tools/call
// and notifications/progress. It shares its framing with the ACP client.

export type McpTool = {
  definition: { name: string; description: string; inputSchema: object };
  call(args: unknown, progress: (message: string) => void, signal: AbortSignal): Promise<ToolResult>;
};

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function serveMcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  tools: McpTool[],
): { closed: Promise<void> } {
  // A client that is gone makes writes fail with EPIPE; that must not crash the process with an unhandled error.
  output.on('error', () => {});
  const peer = createJsonRpcPeer(input, output);
  const aborted = new AbortController();
  void peer.closed.then(() => aborted.abort());

  peer.onRequest('initialize', (params) => {
    const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'automator', version: '1' },
    };
  });
  peer.onRequest('ping', () => ({}));
  peer.onRequest('tools/list', () => ({ tools: tools.map((tool) => tool.definition) }));
  // A call the client cancelled (notifications/cancelled) stops its tool; it must not keep polling or consume an answer.
  const calls = new Map<number | string, AbortController>();
  peer.onNotification('notifications/cancelled', (params) => {
    const requestId = isRecord(params) ? params.requestId : undefined;
    if (typeof requestId === 'string' || typeof requestId === 'number') calls.get(requestId)?.abort();
  });
  peer.onRequest('tools/call', async (params, { id }) => {
    const call = isRecord(params) ? params : {};
    const tool = tools.find((candidate) => candidate.definition.name === call.name);
    if (tool === undefined) throw new JsonRpcError(-32602, `Unknown tool: ${String(call.name)}`);
    const meta = isRecord(call._meta) ? call._meta : {};
    const token =
      typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : null;
    let progress = 0;
    const cancelled = new AbortController();
    calls.set(id, cancelled);
    try {
      return await tool.call(
        call.arguments ?? {},
        (message) => {
          if (token === null) return;
          progress += 1;
          peer.notify('notifications/progress', { progressToken: token, progress, message });
        },
        AbortSignal.any([aborted.signal, cancelled.signal]),
      );
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      } satisfies ToolResult;
    } finally {
      calls.delete(id);
    }
  });
  return { closed: peer.closed };
}
