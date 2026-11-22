// Automator's bundled pi extension. The pi driver loads it with `--no-extensions -e <this file>`, so it needs neither
// user configuration nor project trust. It is plain JavaScript on purpose: pi loads it directly, with no build step,
// from the installed app next to the rest of the source (src/core/chats/pi/).
//
// Every Automator chat tool (ask_user today, schedule_wakeup in PR 5) is registered from the definitions the driver
// passes in AUTOMATOR_CHAT_TOOL, and runs by calling `automator chat-tool <name>` (the same implementation the MCP
// server uses): the JSON arguments go to stdin, a JSON tool result comes back on stdout.
//
// AUTOMATOR_CHAT_TOOL = { command, args: [<bin/automator.mjs>, 'mcp', ...flags], env, tools: [{ name, description, inputSchema }] }
import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 1024 * 1024;

function runChatTool(spec, name, params, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('The turn was stopped.'));
    const [script, , ...flags] = spec.args;
    const child = spawn(spec.command, [script, 'chat-tool', name, ...flags], {
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    // A tool that ignores its AbortSignal would hold pi's abort back until it returns (provider spike, pi item j).
    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error('The turn was stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) return reject(new Error(`automator chat-tool ${name} failed (code ${code}): ${stderr.trim()}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`automator chat-tool ${name} returned invalid output`));
      }
    });
    child.stdin.on('error', () => {});
    // The input is one line; stdin then stays open so the child can tell when this process is gone (its stdin closes)
    // and stop polling, instead of outliving a killed pi for up to questionWaitMs.
    child.stdin.write(`${JSON.stringify(params ?? {})}\n`);
  });
}

export default function automatorExtension(pi) {
  let spec;
  try {
    spec = JSON.parse(process.env.AUTOMATOR_CHAT_TOOL ?? 'null');
  } catch {
    spec = null;
  }
  if (spec === null || !Array.isArray(spec.tools)) return;
  for (const tool of spec.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal) {
        const result = await runChatTool(spec, tool.name, params, signal);
        const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
        if (result.isError) throw new Error(text);
        return { content: [{ type: 'text', text }], details: {} };
      },
    });
  }
}
