// Leaf module: the Automator chat tools' definitions and constants, shared by the drivers, the prompt builder, the
// session manager and the tool implementations without pulling in the database or the queue.

export const ASK_USER_TOOL = {
  name: 'ask_user',
  description:
    'Ask the user a question and wait for the answer. Use options for a choice; omit them for free text. ' +
    'If the result is "No answer yet. Stop and wait for the user", end your turn without further changes.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 2000 },
      options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 2, maxItems: 10 },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;

export const MIN_WAKEUP_MS = 60_000;

export const SCHEDULE_WAKEUP_TOOL = {
  name: 'schedule_wakeup',
  description:
    'Continue this chat later. Give either `delay` (e.g. "15m", "2h", "1d"; at least 1 minute) or `at` ' +
    '(ISO 8601 date-time, at least 1 minute from now), plus the message you will receive when it fires. ' +
    'Only one wake-up is kept per chat: a new one replaces the previous one. It fires within the ' +
    "Repository's working hours. Prefer this over built-in timers, which are lost if the session stops.",
  inputSchema: {
    type: 'object',
    properties: {
      delay: { type: 'string', minLength: 2, maxLength: 20 },
      at: { type: 'string', format: 'date-time' },
      message: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    required: ['message'],
    oneOf: [{ required: ['delay'] }, { required: ['at'] }],
    additionalProperties: false,
  },
} as const;

export const QUESTION_TIMEOUT_REPLY = 'No answer yet. Stop and wait for the user';
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export type ChatToolDefinition = { name: string; description: string; inputSchema: object };

// Registered with the provider: as MCP tools for ACP providers, as pi extension tools for pi.
export const CHAT_TOOL_DEFINITIONS: ChatToolDefinition[] = [ASK_USER_TOOL, SCHEDULE_WAKEUP_TOOL];
