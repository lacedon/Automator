import { lineSplitter } from '../../runs/liveTranscript';

// Newline-delimited JSON-RPC 2.0 peer, written by hand (ACP and MCP stdio share this framing).

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    timeoutMs: number,
  ) {
    super(`No response to ${method} within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'JsonRpcTimeoutError';
  }
}

export const MAX_LINE_CHARS = 8 * 1024 * 1024;
export const MAX_WRITE_BUFFER = 16 * 1024 * 1024;

export type JsonRpcOptions = {
  maxLineChars?: number; // longer incoming lines are dropped and logged
  maxWriteBuffer?: number; // an output that falls this far behind fails the peer
};

export interface JsonRpcPeer {
  // `timeoutMs` bounds the wait for the response; long-running requests (session/prompt) pass none.
  request<T>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params: unknown): void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): void;
  close(): void;
  // Resolves once the input stream ended or the peer was closed.
  readonly closed: Promise<void>;
  closedNow(): boolean;
}

type Message = {
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createJsonRpcPeer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  log: (line: string) => void = () => {},
  options: JsonRpcOptions = {},
): JsonRpcPeer {
  const maxWriteBuffer = options.maxWriteBuffer ?? MAX_WRITE_BUFFER;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number | string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const write = (message: object): void => {
    const line = JSON.stringify(message);
    log(`> ${line}`);
    try {
      output.write(`${line}\n`);
    } catch (error) {
      log(`write failed: ${error instanceof Error ? error.message : String(error)}`);
      closeAll();
      return;
    }
    // Nothing reads the output fast enough: stop buffering without bound and fail the session instead.
    const buffered = (output as { writableLength?: number }).writableLength ?? 0;
    if (buffered > maxWriteBuffer) {
      log(`output backed up (${buffered} bytes buffered); closing the connection`);
      closeAll();
    }
  };
  output.on('error', (error: Error) => {
    log(`write failed: ${error.message}`);
    closeAll();
  });

  const closeAll = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error('The connection is closed'));
    pending.clear();
    resolveClosed();
  };

  const handle = (message: Message): void => {
    const hasMethod = typeof message.method === 'string';
    if (!hasMethod && message.id !== undefined && message.id !== null) {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        const code = typeof message.error.code === 'number' ? message.error.code : -32000;
        const text = typeof message.error.message === 'string' ? message.error.message : 'JSON-RPC error';
        waiter.reject(new JsonRpcError(code, text, message.error.data));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (!hasMethod) return;
    const method = message.method as string;
    if (message.id !== undefined && message.id !== null) {
      const id = message.id;
      const handler = requestHandlers.get(method);
      if (handler === undefined) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
      }
      void (async () => {
        try {
          write({ jsonrpc: '2.0', id, result: (await handler(message.params)) ?? {} });
        } catch (error) {
          write({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          });
        }
      })();
      return;
    }
    try {
      notificationHandlers.get(method)?.(message.params);
    } catch (error) {
      log(`notification handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const onOversize = (chars: number) => log(`oversized line (${chars} chars) dropped`);
  const splitter = lineSplitter(
    (line) => {
      if (closed || line.trim() === '') return;
      log(`< ${line}`);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        log('malformed JSON line ignored');
        return;
      }
      if (!isRecord(value)) {
        log('malformed JSON-RPC message ignored');
        return;
      }
      handle(value as Message);
    },
    { maxLineChars: options.maxLineChars ?? MAX_LINE_CHARS, onOversize },
  );
  input.on('data', (chunk: Buffer | string) => splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const onEnd = () => {
    splitter.end();
    closeAll();
  };
  input.on('end', onEnd);
  input.on('close', onEnd);
  input.on('error', onEnd);

  return {
    request<T>(method: string, params: unknown, requestOptions: { timeoutMs?: number } = {}): Promise<T> {
      if (closed) return Promise.reject(new Error('The connection is closed'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timeoutMs = requestOptions.timeoutMs;
        const timer =
          timeoutMs === undefined
            ? null
            : setTimeout(() => {
                if (pending.delete(id)) reject(new JsonRpcTimeoutError(method, timeoutMs));
              }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            if (timer !== null) clearTimeout(timer);
            resolve(value as T);
          },
          reject: (error) => {
            if (timer !== null) clearTimeout(timer);
            reject(error);
          },
        });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      if (!closed) write({ jsonrpc: '2.0', method, params });
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },
    close: closeAll,
    closed: closedPromise,
    closedNow: () => closed,
  };
}
