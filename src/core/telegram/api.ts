export interface TelegramUser {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type InlineButton = { text: string; data: string };
export type InlineKeyboard = InlineButton[][];

// The slice of the Telegram Bot API the bot uses. Tests replace it with a fake; nothing else touches the network.
export interface TelegramApi {
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  // The token is part of the URL, so it must never appear in an error message.
  const call = async <T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new TelegramApiError(`${method}: network error (${(e as Error).name})`, null);
    }
    const json = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!response.ok || json?.ok !== true)
      throw new TelegramApiError(`${method}: ${json?.description ?? `HTTP ${response.status}`}`, response.status);
    return json.result as T;
  };
  return {
    getUpdates: (offset, timeout, signal) =>
      call<TelegramUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, signal),
    async sendMessage(chatId, text, keyboard) {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(keyboard === undefined
          ? {}
          : {
              reply_markup: {
                inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
              },
            }),
      });
    },
    async answerCallbackQuery(id, text) {
      await call('answerCallbackQuery', { callback_query_id: id, ...(text === undefined ? {} : { text }) });
    },
    async deleteMessage(chatId, messageId) {
      await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
  };
}
