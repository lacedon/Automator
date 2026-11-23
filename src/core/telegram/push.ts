import type { AccessService } from '../access/accessService';
import type { Database } from '../db/open';
import type { UserService } from '../users/userService';
import { TelegramApiError, type InlineKeyboard } from './api';
import { oneLine, runStatusLabel, truncate } from './format';
import type { TelegramStore } from './store';

export interface PushDeps {
  db: Database;
  store: TelegramStore;
  users: UserService;
  access: AccessService;
  now: () => number;
  dashboardUrl: string;
  log?: (line: string) => void;
  send(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
}

type Candidate = {
  kind: 'needs_you' | 'chat_finished' | 'run_failed';
  refId: number;
  at: number;
  text: string;
  // Who may receive it, decided per linked user.
  allowed: (userId: number) => boolean;
};

const SINCE_KEY = 'push_since';
// Events older than this are never pushed or scanned again, which keeps each tick and the push log bounded.
export const PUSH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Pushes are derived from the database, so they work whatever process finished the Run and survive restarts.
// A push is reserved in the log before it is sent, so it goes out once per chat, and is released if sending fails.
export class TelegramPusher {
  private failedAt = 0;
  private backoffMs = 0;

  constructor(private readonly deps: PushDeps) {}

  private candidates(since: number): Candidate[] {
    const { db, access, dashboardUrl } = this.deps;
    const out: Candidate[] = [];
    const events = db
      .prepare(
        `SELECT e.id, e.watch_id, e.reason, e.created_at, COALESCE(w.name, w.title) AS title FROM needs_you_events e
         LEFT JOIN watches w ON w.id = e.watch_id WHERE e.created_at >= ?`,
      )
      .all(since) as { id: number; watch_id: number; reason: string; created_at: number; title: string | null }[];
    for (const e of events) {
      out.push({
        kind: 'needs_you',
        refId: e.id,
        at: e.created_at,
        text: `🔴 "${oneLine(e.title ?? `Automation ${e.watch_id}`, 80)}" needs you: ${truncate(e.reason, 1000).text}\n${dashboardUrl}/automations/${e.watch_id}`,
        allowed: (userId) => access.canOnWatch(userId, 'read', e.watch_id),
      });
    }
    const runs = db
      .prepare(
        `SELECT r.id, r.watch_id, r.repository, r.status, r.outcome, r.result_status, r.interrupted, r.summary,
           r.error_json, r.ended_at, r.owner_user_id, COALESCE(w.name, w.title) AS title
         FROM runs r LEFT JOIN watches w ON w.id = r.watch_id WHERE r.status = 'finished' AND r.ended_at >= ?`,
      )
      .all(since) as {
      id: number;
      watch_id: number | null;
      repository: string;
      outcome: string | null;
      result_status: 'success' | 'error' | null;
      interrupted: string | null;
      summary: string | null;
      error_json: string | null;
      ended_at: number;
      owner_user_id: number | null;
      title: string | null;
    }[];
    for (const r of runs) {
      // A cancelled Run was the user's own doing.
      if (r.interrupted === 'cancelled') continue;
      const failed = r.result_status === 'error' || r.interrupted !== null;
      const label = runStatusLabel({
        status: 'finished',
        outcome: r.outcome as never,
        resultStatus: r.result_status,
        interrupted: r.interrupted,
      });
      const link = `${dashboardUrl}/runs/${r.id}`;
      if (failed) {
        let error = '';
        try {
          error = r.error_json === null ? '' : ((JSON.parse(r.error_json) as { message?: string }).message ?? '');
        } catch {
          // An unreadable error is simply left out.
        }
        const what =
          r.watch_id === null ? `Chat in ${r.repository}` : `Automation #${r.watch_id} "${oneLine(r.title, 60)}"`;
        out.push({
          kind: 'run_failed',
          refId: r.id,
          at: r.ended_at,
          text: `❌ Run #${r.id} ${label} (${what})${error === '' ? '' : `\n${truncate(error, 800).text}`}\n${link}`,
          // Chats are personal to their owner; Automation failures go to everyone who can read the Automation.
          allowed: (userId) =>
            r.watch_id === null ? r.owner_user_id === userId : access.canOnWatch(userId, 'read', r.watch_id),
        });
      } else if (r.watch_id === null) {
        out.push({
          kind: 'chat_finished',
          refId: r.id,
          at: r.ended_at,
          text: `✅ Chat Run #${r.id} finished${r.summary ? `:\n${truncate(r.summary, 1500).text}` : ''}\n${link}`,
          allowed: (userId) => r.owner_user_id === userId,
        });
      }
    }
    return out;
  }

  // Returns how many messages were sent. After a Telegram failure it waits (capped exponential backoff) before trying again.
  async tick(): Promise<number> {
    const { store, users, now, send } = this.deps;
    const t = now();
    if (t - this.failedAt < this.backoffMs) return 0;
    let since = Number(store.getState(SINCE_KEY));
    if (!Number.isFinite(since) || since === 0) {
      since = t;
      store.setState(SINCE_KEY, String(t));
    }
    // Pushes older than the window can no longer be candidates (an event predates its push), so their log rows go.
    const from = Math.max(since, t - PUSH_LOOKBACK_MS);
    store.prunePushLog(t - PUSH_LOOKBACK_MS);
    const links = store.links();
    if (links.length === 0) return 0;
    let sent = 0;
    let failure: unknown = null;
    for (const c of this.candidates(from)) {
      for (const link of links) {
        if (c.at < link.linkedAt || !c.allowed(link.userId)) continue;
        if (!users.isFingerprintValid(link.userId, link.tokenFingerprint)) {
          store.unlink(link.telegramUserId);
          continue;
        }
        if (!store.reservePush(c.kind, c.refId, link.chatId)) continue;
        try {
          await send(link.chatId, c.text);
          sent += 1;
        } catch (e) {
          store.releasePush(c.kind, c.refId, link.chatId);
          if (isPermanent(e)) {
            // The user blocked the bot or deleted the chat: retrying never helps, so drop this link only.
            store.unlink(link.telegramUserId);
            this.deps.log?.(`telegram link ${link.telegramUserId} removed: ${(e as Error).message}`);
            continue;
          }
          // Transient: other links still get their push; this one is retried after a backoff.
          failure ??= e;
          const retryAfter = e instanceof TelegramApiError ? (e.retryAfterSeconds ?? 0) * 1000 : 0;
          this.failedAt = now();
          this.backoffMs = Math.min(Math.max(this.backoffMs === 0 ? 5_000 : this.backoffMs * 2, retryAfter), 300_000);
        }
      }
    }
    if (failure !== null) throw failure;
    if (sent > 0) this.backoffMs = 0;
    return sent;
  }
}

const isPermanent = (e: unknown): boolean =>
  e instanceof TelegramApiError && (e.status === 403 || (e.status === 400 && /chat not found/i.test(e.message)));
