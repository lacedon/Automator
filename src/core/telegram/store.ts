import type { Database } from '../db/open';

export interface TelegramLink {
  telegramUserId: number;
  chatId: number;
  userId: number;
  tokenFingerprint: string;
  linkedAt: number;
}

export type Wizard =
  | { step: 'repository' }
  | { step: 'ticket'; repository: string }
  | { step: 'options'; repository: string; ticket: string | null; model: string | null; agentId: number | null }
  | { step: 'prompt'; repository: string; ticket: string | null; model: string | null; agentId: number | null };

export interface ChatState {
  projectId: number | null;
  currentRunId: number | null;
  wizard: Wizard | null;
}

type Row = Record<string, unknown>;

// Everything the bot persists. The Telegram bot token and the Automator access tokens are never stored here.
export class TelegramStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
  ) {}

  link(telegramUserId: number): TelegramLink | null {
    const r = this.db.prepare('SELECT * FROM telegram_links WHERE telegram_user_id = ?').get(telegramUserId) as
      Row | undefined;
    return r === undefined ? null : toLink(r);
  }

  links(): TelegramLink[] {
    return (this.db.prepare('SELECT * FROM telegram_links').all() as Row[]).map(toLink);
  }

  setLink(telegramUserId: number, chatId: number, userId: number, tokenFingerprint: string): void {
    this.db
      .prepare(
        `INSERT INTO telegram_links (telegram_user_id, chat_id, user_id, token_fingerprint, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id = excluded.chat_id, user_id = excluded.user_id,
           token_fingerprint = excluded.token_fingerprint, linked_at = excluded.linked_at`,
      )
      .run(telegramUserId, chatId, userId, tokenFingerprint, this.now());
  }

  unlink(telegramUserId: number): void {
    const link = this.link(telegramUserId);
    this.db.prepare('DELETE FROM telegram_links WHERE telegram_user_id = ?').run(telegramUserId);
    if (link !== null) this.db.prepare('DELETE FROM telegram_chat_state WHERE chat_id = ?').run(link.chatId);
  }

  chatState(chatId: number): ChatState {
    const r = this.db.prepare('SELECT * FROM telegram_chat_state WHERE chat_id = ?').get(chatId) as Row | undefined;
    if (r === undefined) return { projectId: null, currentRunId: null, wizard: null };
    return {
      projectId: r.project_id as number | null,
      currentRunId: r.current_run_id as number | null,
      wizard: r.wizard_json === null ? null : (JSON.parse(r.wizard_json as string) as Wizard),
    };
  }

  saveChatState(chatId: number, patch: Partial<ChatState>): void {
    const next = { ...this.chatState(chatId), ...patch };
    this.db
      .prepare(
        `INSERT INTO telegram_chat_state (chat_id, project_id, current_run_id, wizard_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id, current_run_id = excluded.current_run_id,
           wizard_json = excluded.wizard_json, updated_at = excluded.updated_at`,
      )
      .run(
        chatId,
        next.projectId,
        next.currentRunId,
        next.wizard === null ? null : JSON.stringify(next.wizard),
        this.now(),
      );
  }

  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM telegram_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return r?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO telegram_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // Reserves a push so it is sent once; release() frees it again when sending failed.
  reservePush(kind: string, refId: number, chatId: number): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO telegram_push_log (kind, ref_id, chat_id, sent_at) VALUES (?, ?, ?, ?)')
        .run(kind, refId, chatId, this.now()).changes === 1
    );
  }

  prunePushLog(olderThan: number): void {
    this.db.prepare('DELETE FROM telegram_push_log WHERE sent_at < ?').run(olderThan);
  }

  releasePush(kind: string, refId: number, chatId: number): void {
    this.db
      .prepare('DELETE FROM telegram_push_log WHERE kind = ? AND ref_id = ? AND chat_id = ?')
      .run(kind, refId, chatId);
  }
}

function toLink(r: Row): TelegramLink {
  return {
    telegramUserId: r.telegram_user_id as number,
    chatId: r.chat_id as number,
    userId: r.user_id as number,
    tokenFingerprint: r.token_fingerprint as string,
    linkedAt: r.linked_at as number,
  };
}
