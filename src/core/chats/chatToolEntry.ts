import { loadConfig } from '../config/load';
import { ConfigResolver } from '../config/resolver';
import { openDb } from '../db/open';
import { systemClock } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { CHAT_TOOLS, type ChatToolContext, type ToolResult } from './chatTools';
import { serveMcp } from './mcpServer';

// Entry points for the processes the agent's provider launches: `automator mcp` (ACP providers) and
// `automator chat-tool <name>` (the bundled pi extension). They are lightweight: the config and the SQLite file only,
// no createCore. The worker owns migrations and the schema, so these never migrate.

export type ChatToolProcessOptions = { configPath: string; sessionId: number; nonce: string };

function open(options: ChatToolProcessOptions): { ctx: ChatToolContext; close(): void } {
  const config = loadConfig({ path: options.configPath });
  const db = openDb(new DataDir(config.dataDir).db);
  const configs = new ConfigResolver(db, config, process.env);
  return {
    ctx: {
      db,
      clock: systemClock,
      sessionId: options.sessionId,
      nonce: options.nonce,
      configFor: (repository) => configs.forRepository(repository),
    },
    close: () => db.close(),
  };
}

export async function runChatMcpServer(
  options: ChatToolProcessOptions & { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
): Promise<void> {
  const { ctx, close } = open(options);
  try {
    const server = serveMcp(
      options.input,
      options.output,
      CHAT_TOOLS.map((tool) => ({
        definition: tool.definition,
        call: (args, progress, signal) => tool.run({ ...ctx, signal, onProgress: progress }, args),
      })),
    );
    await server.closed;
  } finally {
    close();
  }
}

export async function runChatTool(
  options: ChatToolProcessOptions & { name: string; args: unknown; signal?: AbortSignal },
): Promise<ToolResult> {
  const tool = CHAT_TOOLS.find((candidate) => candidate.definition.name === options.name);
  if (tool === undefined) {
    return { content: [{ type: 'text', text: `Unknown chat tool "${options.name}".` }], isError: true };
  }
  const { ctx, close } = open(options);
  try {
    return await tool.run(
      { ...ctx, ...(options.signal === undefined ? {} : { signal: options.signal }) },
      options.args,
    );
  } finally {
    close();
  }
}
