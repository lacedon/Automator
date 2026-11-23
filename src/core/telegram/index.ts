import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { createTelegramApi, TelegramApiError, type TelegramApi } from './api';
import { TelegramBot, type TelegramServices } from './bot';
import { TelegramPusher } from './push';
import { TelegramStore } from './store';
import { splitMessage } from './format';

export type { TelegramApi, TelegramUpdate } from './api';
export { TelegramBot } from './bot';
export { TelegramPusher } from './push';
export { TelegramStore } from './store';
export { splitMessage, TELEGRAM_LIMIT } from './format';

const OFFSET_KEY = 'update_offset';
const POLL_SECONDS = 30;
const PUSH_EVERY_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export interface TelegramRunner {
  start(): void;
  stop(): Promise<void>;
}

export interface TelegramRunnerOptions {
  db: Database;
  services: TelegramServices;
  dashboardUrl: string;
  api: TelegramApi;
  log?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pushEveryMs?: number;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

// Long polling: an outbound HTTPS request that Telegram answers when an update arrives. Failures back off and retry.
export function createTelegramRunner(options: TelegramRunnerOptions): TelegramRunner {
  const { db, services, api } = options;
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const sleep = options.sleep ?? abortableSleep;
  const store = new TelegramStore(db, () => services.clock.now());
  const bot = new TelegramBot({ api, store, services, dashboardUrl: options.dashboardUrl, log });
  const pusher = new TelegramPusher({
    db,
    store,
    users: services.users,
    access: services.access,
    now: () => services.clock.now(),
    dashboardUrl: options.dashboardUrl,
    log,
    send: async (chatId, text) => {
      for (const part of splitMessage(text)) await api.sendMessage(chatId, part);
    },
  });
  const abort = new AbortController();
  let loops: Promise<void>[] = [];

  const pollLoop = async () => {
    let backoff = 1_000;
    while (!abort.signal.aborted) {
      try {
        const offset = Number(store.getState(OFFSET_KEY) ?? 0);
        const updates = await api.getUpdates(offset, POLL_SECONDS, abort.signal);
        backoff = 1_000;
        for (const update of updates) {
          // Persist first: an update that crashes a handler must not be replayed forever.
          store.setState(OFFSET_KEY, String(update.update_id + 1));
          await bot.handleUpdate(update);
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        const status = e instanceof TelegramApiError ? e.status : null;
        if (status === 401) {
          // A wrong or revoked bot token never recovers by itself: say so clearly and retry only at the slowest pace.
          log('telegram bot token was rejected (401 Unauthorized): check the token in .env; retrying every 60 s');
          backoff = MAX_BACKOFF_MS;
        } else {
          log(
            `telegram polling failed: ${e instanceof Error ? e.message : String(e)}; retrying in ${backoff / 1000} s`,
          );
        }
        const retryAfter = e instanceof TelegramApiError ? (e.retryAfterSeconds ?? 0) * 1000 : 0;
        await sleep(Math.max(backoff, retryAfter), abort.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  };

  const pushLoop = async () => {
    while (!abort.signal.aborted) {
      try {
        await pusher.tick();
      } catch (e) {
        log(`telegram push failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(options.pushEveryMs ?? PUSH_EVERY_MS, abort.signal);
    }
  };

  return {
    start() {
      if (loops.length > 0) return;
      loops = [pollLoop(), pushLoop()];
      log('telegram bot started (long polling)');
    },
    async stop() {
      abort.abort();
      await Promise.all(loops);
      loops = [];
    },
  };
}

export interface TelegramStartOptions {
  config: Config;
  db: Database;
  services: TelegramServices;
  env?: Record<string, string | undefined>;
  api?: TelegramApi;
  log?: (line: string) => void;
}

// null when the bot is not configured (or has no token): nothing is started and no network is touched.
export function createTelegramBot(options: TelegramStartOptions): TelegramRunner | null {
  const { telegram } = options.config;
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  if (telegram === undefined || !telegram.enabled) return null;
  const token = (options.env ?? process.env)[telegram.tokenEnv];
  if (options.api === undefined && (token === undefined || token.trim() === '')) {
    log(`telegram bot is enabled but ${telegram.tokenEnv} is not set; the bot stays off`);
    return null;
  }
  return createTelegramRunner({
    db: options.db,
    services: options.services,
    dashboardUrl: telegram.dashboardUrl,
    api: options.api ?? createTelegramApi(token!.trim()),
    log,
  });
}
