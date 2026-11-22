import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConfigFor } from '../config/resolver';
import type { Database } from '../db/open';
import { toChatSession } from '../db/rows';
import type { Clock } from '../domain/types';
import { ASK_USER_TOOL, QUESTION_TIMEOUT_REPLY, type ChatToolDefinition, type ToolResult } from './chatToolDefs';
import { needsSettling, openQuestion, settleQuestion } from './questions';

// The Automator tools an Interactive Chat's agent can call. One implementation serves both the stdio MCP server (ACP
// providers) and `automator chat-tool <name>` (the bundled pi extension). PR 5 adds schedule_wakeup here.

export const PROGRESS_EVERY_MS = 30_000;
export const POLL_MS = 500;

export interface ChatToolContext {
  db: Database;
  clock: Clock;
  sessionId: number;
  nonce: string;
  configFor: ConfigFor;
  pollMs?: number;
  signal?: AbortSignal;
  progressEveryMs?: number;
  onProgress?: (message: string) => void;
}

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});

const askUserInput = z
  .object({
    question: z.string().trim().min(1).max(2000),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(10).optional(),
  })
  .strict();

// The nonce limits accidental cross-session calls; it is not a security boundary.
function authorize(ctx: ChatToolContext): { repository: string } | ToolResult {
  const row = ctx.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(ctx.sessionId);
  if (row === undefined) return text('This chat does not exist.', true);
  const session = toChatSession(row);
  if (session.mcpNonce === null || session.mcpNonce !== ctx.nonce) return text('This chat session is not valid.', true);
  if (session.closedAt !== null || session.closeRequestedAt !== null) return text('This chat is closed.', true);
  return { repository: session.repository };
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export async function askUser(ctx: ChatToolContext, input: unknown): Promise<ToolResult> {
  const parsed = askUserInput.safeParse(input);
  if (!parsed.success) return text(`Invalid ask_user input: ${z.prettifyError(parsed.error)}`, true);
  const allowed = authorize(ctx);
  if ('content' in allowed) return allowed;
  const running = ctx.db
    .prepare("SELECT id FROM runs WHERE chat_session_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(ctx.sessionId) as { id: number } | undefined;
  if (running === undefined) return text('This chat has no turn in progress, so there is nobody to ask.', true);

  const requestId = randomUUID();
  const opened = openQuestion(ctx.db, {
    sessionId: ctx.sessionId,
    runId: running.id,
    text: parsed.data.question,
    options: parsed.data.options ?? null,
    source: 'automator',
    requestId,
    now: ctx.clock.now(),
    waitMs: ctx.configFor(allowed.repository).runs.questionWaitMs,
  });
  if (!opened.ok) {
    return text(
      opened.error.code === 'INVALID_INPUT'
        ? `${opened.error.message}. Wait for it to be answered before asking another question.`
        : 'The question could not be asked.',
      true,
    );
  }

  const pollMs = ctx.pollMs ?? POLL_MS;
  const progressEveryMs = ctx.progressEveryMs ?? PROGRESS_EVERY_MS;
  let lastProgress = ctx.clock.now();
  // The loop reads with a plain SELECT (no write lock) and enters the IMMEDIATE settleQuestion only when an answer,
  // the expiry or a vanished question is seen; settleQuestion re-checks inside its transaction.
  for (;;) {
    // A cancelled call must not settle again: it could consume an answer meant for a later question or turn.
    if (ctx.signal?.aborted === true) return text('The question was cancelled because the turn was stopped.', true);
    if (needsSettling(ctx.db, ctx.sessionId, requestId, ctx.clock.now())) {
      const settled = settleQuestion(ctx.db, ctx.sessionId, requestId, ctx.clock.now());
      if (settled.kind === 'answered') return text(settled.text);
      // `gone`: the answer already started a new turn, or the chat was closed; either way this turn must stop.
      if (settled.kind === 'expired' || settled.kind === 'gone') return text(QUESTION_TIMEOUT_REPLY);
    }
    const now = ctx.clock.now();
    if (ctx.onProgress !== undefined && now - lastProgress >= progressEveryMs) {
      lastProgress = now;
      ctx.onProgress('Waiting for the user to answer');
    }
    await sleep(pollMs, ctx.signal);
  }
}

export type ChatTool = {
  definition: ChatToolDefinition;
  run(ctx: ChatToolContext, input: unknown): Promise<ToolResult>;
};

// Registry shared by the MCP server and `automator chat-tool`; PR 5 registers schedule_wakeup here.
export const CHAT_TOOLS: ChatTool[] = [{ definition: ASK_USER_TOOL, run: askUser }];
