// Leaf module: the Automator chat tools' definitions and constants, shared by the drivers, the prompt builder, the
// session manager and the tool implementations without pulling in the database or the queue. PR 5 adds schedule_wakeup.

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

export const QUESTION_TIMEOUT_REPLY = 'No answer yet. Stop and wait for the user';
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export type ChatToolDefinition = { name: string; description: string; inputSchema: object };

// Registered with the provider: as MCP tools for ACP providers, as pi extension tools for pi.
export const CHAT_TOOL_DEFINITIONS: ChatToolDefinition[] = [ASK_USER_TOOL];
