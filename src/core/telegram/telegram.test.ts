import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch } from '../../../test/helpers/db';
import { createCore, type Core } from '../index';
import { TelegramApiError, type InlineKeyboard, type TelegramApi, type TelegramUpdate } from './api';
import { TelegramBot } from './bot';
import { createTelegramBot, createTelegramRunner } from './index';
import { PUSH_LOOKBACK_MS, TelegramPusher } from './push';
import { splitMessage, TELEGRAM_LIMIT } from './format';
import { TelegramStore } from './store';

type Sent = { chatId: number; text: string; keyboard?: InlineKeyboard };

class FakeApi implements TelegramApi {
  sent: Sent[] = [];
  deleted: number[] = [];
  answered: string[] = [];
  failSends = false;
  polls: (TelegramUpdate[] | Error)[] = [];
  async getUpdates(_o: number, _t: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const next = this.polls.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
    throw new Error('aborted');
  }
  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard) {
    if (this.failSends) throw new TelegramApiError('sendMessage: down', 502);
    this.sent.push({ chatId, text, ...(keyboard === undefined ? {} : { keyboard }) });
  }
  async answerCallbackQuery(id: string) {
    this.answered.push(id);
  }
  async deleteMessage(_c: number, id: number) {
    this.deleted.push(id);
  }
  get last(): Sent {
    return this.sent[this.sent.length - 1]!;
  }
  texts = () => this.sent.map((s) => s.text).join('\n---\n');
}

let core: Core;
let api: FakeApi;
let store: TelegramStore;
let bot: TelegramBot;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;
let adminToken: string;
let adminTokenId: number;

const CHAT = 100;
const TG = 100;

beforeEach(() => {
  clock = fakeClock();
  const config = testConfig();
  core = createCore(config, { clock, notifier: { async notifyNeedsYou() {} } }, { repositories: config.repositories });
  api = new FakeApi();
  store = new TelegramStore(core.db, () => clock.now());
  bot = new TelegramBot({ api, store, services: services(), dashboardUrl: 'http://dash/' });
  const admin = core.users.list()[0]!;
  const made = core.users.createToken(admin.id, 'telegram', null);
  if (!made.ok) throw new Error('token');
  adminToken = made.value.token;
  adminTokenId = made.value.id;
});

afterEach(() => core.close());

const services = () => ({
  clock,
  users: core.users,
  access: core.access,
  read: core.read,
  watches: core.watches,
  queue: core.queue,
  projects: core.projects,
});

const say = (text: string, from = TG, chat = CHAT) =>
  bot.handleUpdate({
    update_id: ++seq,
    message: { message_id: ++seq, chat: { id: chat, type: 'private' }, from: { id: from }, text },
  });
const press = (data: string, from = TG, chat = CHAT) =>
  bot.handleUpdate({
    update_id: ++seq,
    callback_query: {
      id: `cb${seq}`,
      from: { id: from },
      data,
      message: { message_id: 1, chat: { id: chat, type: 'private' } },
    },
  });
const login = () => say(`/login ${adminToken}`);

describe('authentication', () => {
  test('an unlinked chat can only log in', async () => {
    await say('/watches');
    expect(api.last.text).toContain('Not logged in');
    await press('w:1');
    expect(api.answered).toHaveLength(0 + 1);
    expect(api.texts()).not.toContain('Automation');
  });

  test('rejects an invalid token, deletes the message, links on a valid one without storing it', async () => {
    await say('/login atk_wrong');
    expect(api.last.text).toContain('invalid');
    expect(store.link(TG)).toBeNull();
    await login();
    expect(api.deleted).toHaveLength(2);
    expect(store.link(TG)).toMatchObject({ userId: core.users.list()[0]!.id });
    expect(api.last.text).toContain('Logged in as admin');
    const stored = JSON.stringify(core.db.prepare('SELECT * FROM telegram_links').all());
    expect(stored).not.toContain(adminToken);
  });

  test('a revoked token unlinks the chat on its next message', async () => {
    await login();
    core.users.revokeToken(core.users.list()[0]!.id, adminTokenId);
    await say('/watches');
    expect(store.link(TG)).toBeNull();
    expect(api.last.text).toContain('no longer valid');
  });

  test('a disabled user is unlinked', async () => {
    await login();
    core.users.setDisabled(core.users.list()[0]!.id, true);
    await say('/watches');
    expect(store.link(TG)).toBeNull();
  });

  test('ignores group chats', async () => {
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: -5, type: 'group' }, from: { id: 1 }, text: '/watches' },
    });
    expect(api.sent).toHaveLength(0);
  });
});

describe('Automations', () => {
  test('lists non-closed Automations with needs-you first and scopes by Project', async () => {
    insertWatch(core.db, { title: 'Active one', state: 'active', repository: 'pages' });
    insertWatch(core.db, { title: 'Closed one', state: 'closed', repository: 'pages' });
    insertWatch(core.db, { title: 'Needs one', state: 'needs_you', repository: 'api' });
    await login();
    await say('/watches');
    const text = api.last.text;
    expect(text).not.toContain('Closed one');
    expect(text.indexOf('Needs one')).toBeLessThan(text.indexOf('Active one'));
    expect(text).toContain('MR');
    expect(text).toContain('merge_requests');

    const project = core.projects.create('Web');
    if (!project.ok) throw new Error('project');
    core.projects.setRepositories(project.value.id, ['pages']);
    await say('/project');
    expect(api.last.keyboard!.flat().map((b) => b.data)).toContain(`p:${project.value.id}`);
    await press(`p:${project.value.id}`);
    await say('/watches');
    expect(api.last.text).toContain('Active one');
    expect(api.last.text).not.toContain('Needs one');
  });

  test('shows details with the latest Runs, a Run result and a dashboard link', async () => {
    const id = insertWatch(core.db, { title: 'MR title', state: 'active' });
    const run = core.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at, ended_at, outcome, result_status, summary)
         VALUES (?, 'pages', 'finished', 'schedule', 0, 'x', 'm', ?, ?, 'acted', 'success', ?) RETURNING id`,
      )
      .get(id, clock.now(), clock.now(), 'S'.repeat(9000)) as { id: number };
    await login();
    await say(`/watch ${id}`);
    expect(api.last.text).toContain(`#${run.id} acted`);
    expect(api.last.text).toContain(`http://dash/automations/${id}`);
    await press(`r:${run.id}`);
    const parts = api.sent.slice(-3);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.text.length <= TELEGRAM_LIMIT)).toBe(true);
    expect(api.texts()).toContain('Outcome: acted');
    expect(api.texts()).toContain('truncated');
    expect(api.texts()).toContain(`http://dash/runs/${run.id}`);
  });

  test('pauses, resumes, closes after confirmation and runs now', async () => {
    const id = insertWatch(core.db, { state: 'active' });
    await login();
    await press(`a:pause:${id}`);
    expect(core.watches.get(id)!.state).toBe('paused');
    await press(`a:resume:${id}`);
    expect(core.watches.get(id)!.state).toBe('active');
    await press(`a:run:${id}`);
    expect(core.db.prepare("SELECT count(*) AS n FROM runs WHERE watch_id = ? AND status = 'queued'").get(id)).toEqual({
      n: 1,
    });
    await press(`a:close:${id}`);
    expect(core.watches.get(id)!.state).toBe('active');
    expect(api.last.text).toContain('Close Automation');
    await press(`a:closeok:${id}`);
    expect(core.watches.get(id)!.state).toBe('closed');
  });

  test('authorizes actions server-side as the linked user', async () => {
    const id = insertWatch(core.db, { state: 'active' });
    const bob = core.users.create('bob', 'secret-pass');
    if (!bob.ok) throw new Error('bob');
    const token = core.users.createToken(bob.value.id, 't', null);
    if (!token.ok) throw new Error('token');
    await say(`/login ${token.value.token}`, 7, 7);
    await press(`a:pause:${id}`, 7, 7);
    expect(core.watches.get(id)!.state).toBe('active');
    expect(api.last.text).toContain('not allowed');
    await say(`/watch ${id}`, 7, 7);
    expect(api.last.text).toContain('not found');
  });
});

describe('chats', () => {
  test('guided /chat starts a chat; plain text continues it as a Follow-up run; /chats lists it', async () => {
    await login();
    await say('/chat');
    expect(api.last.keyboard!.flat().map((b) => b.text)).toContain('pages');
    await press('wz:repo:1');
    expect(api.last.text).toContain('ticket');
    await press('wz:skip');
    expect(api.last.text).toContain('Model:');
    await press('wz:go');
    await say('Fix the README');
    const run = core.db.prepare('SELECT id, repository, adhoc_prompt, owner_user_id FROM runs').get() as {
      id: number;
      repository: string;
      adhoc_prompt: string;
      owner_user_id: number;
    };
    expect(run).toMatchObject({ adhoc_prompt: 'Fix the README', owner_user_id: core.users.list()[0]!.id });
    expect(store.chatState(CHAT).currentRunId).toBe(run.id);

    // Not finished yet: a reply is explained, not queued.
    await say('more');
    expect(api.last.text).toContain('still running');

    core.db
      .prepare(
        "UPDATE runs SET status = 'finished', session_id = 's1', outcome = 'done', result_status = 'success', summary = 'Done it', ended_at = ? WHERE id = ?",
      )
      .run(clock.now(), run.id);
    await say('and the tests');
    const child = core.db.prepare('SELECT adhoc_prompt, parent_run_id FROM runs WHERE id <> ?').get(run.id);
    expect(child).toEqual({ adhoc_prompt: 'and the tests', parent_run_id: run.id });

    await say('/chats');
    expect(api.last.text).toContain('Your last 1 chats');
    await press(`c:${run.id}`);
    expect(api.last.text).toContain('You: Fix the README');
    expect(api.last.text).toContain('Done it');
  });

  test('keeps the wizard on a rejected ticket and supports /cancel', async () => {
    await login();
    await say('/chat');
    await press('wz:repo:0');
    await say('nonsense');
    await press('wz:go');
    await press('wz:start');
    expect(api.texts()).toContain('ticket');
    expect(core.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
    await say('/cancel');
    expect(store.chatState(CHAT).wizard).toBeNull();
  });

  test('reports handler errors in the chat', async () => {
    await login();
    core.db.exec('DROP TABLE telegram_chat_state');
    await say('/chats');
    expect(api.last.text).toContain('could not handle');
  });
});

describe('push messages', () => {
  const pusher = () =>
    new TelegramPusher({
      db: core.db,
      store,
      users: core.users,
      access: core.access,
      now: () => clock.now(),
      dashboardUrl: 'http://dash',
      send: (chatId, text) => api.sendMessage(chatId, text),
    });

  test('sends needs-you, chat-finished and failed once, only to authorized links, never for history', async () => {
    const old = insertWatch(core.db, { title: 'Old', state: 'needs_you' });
    core.db
      .prepare("INSERT INTO needs_you_events (watch_id, reason, created_at, teams_status) VALUES (?, 'old', ?, 'sent')")
      .run(old, clock.now() - 1000);
    const p = pusher();
    await p.tick(); // establishes the baseline
    await login();
    clock.advance(1000);
    const id = insertWatch(core.db, { title: 'MR title', state: 'needs_you' });
    core.db
      .prepare(
        "INSERT INTO needs_you_events (watch_id, reason, created_at, teams_status) VALUES (?, 'conflict', ?, 'pending')",
      )
      .run(id, clock.now());
    const chat = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'hi', model: 'm' });
    const failing = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'bad', model: 'm' });
    core.db
      .prepare(
        "UPDATE runs SET status = 'finished', outcome = 'done', result_status = 'success', summary = 'Hello', ended_at = ? WHERE id = ?",
      )
      .run(clock.now(), chat.id);
    core.db
      .prepare(
        "UPDATE runs SET status = 'finished', result_status = 'error', error_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(JSON.stringify({ code: 'x', message: 'boom' }), clock.now(), failing.id);
    api.sent = [];
    expect(await p.tick()).toBe(3);
    const text = api.texts();
    expect(text).toContain('"MR title" needs you: conflict');
    expect(text).toContain('Hello');
    expect(text).toContain('boom');
    expect(text).not.toContain('Old');
    expect(await p.tick()).toBe(0);
  });

  test('only scans the lookback window and prunes the push log', async () => {
    const p = pusher();
    await p.tick();
    await login();
    clock.advance(1000);
    const event = (reason: string) => {
      const id = insertWatch(core.db, { state: 'needs_you' });
      core.db
        .prepare(
          "INSERT INTO needs_you_events (watch_id, reason, created_at, teams_status) VALUES (?, ?, ?, 'pending')",
        )
        .run(id, reason, clock.now());
    };
    event('first');
    expect(await p.tick()).toBe(1);
    expect(core.db.prepare('SELECT count(*) AS n FROM telegram_push_log').get()).toEqual({ n: 1 });

    clock.advance(PUSH_LOOKBACK_MS + 1000);
    // Simulate a lost log row: the event is now outside the window, so it must not be re-sent.
    core.db.prepare('DELETE FROM telegram_push_log').run();
    event('second');
    api.sent = [];
    expect(await p.tick()).toBe(1);
    expect(api.texts()).toContain('second');
    expect(api.texts()).not.toContain('first');

    clock.advance(PUSH_LOOKBACK_MS + 1000);
    await p.tick();
    expect(core.db.prepare('SELECT count(*) AS n FROM telegram_push_log').get()).toEqual({ n: 0 });
  });

  test('retries after a Telegram outage without duplicating', async () => {
    const p = pusher();
    await p.tick();
    await login();
    clock.advance(1000);
    const run = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'hi', model: 'm' });
    core.db
      .prepare(
        "UPDATE runs SET status = 'finished', outcome = 'done', result_status = 'success', ended_at = ? WHERE id = ?",
      )
      .run(clock.now(), run.id);
    api.sent = [];
    api.failSends = true;
    await expect(p.tick()).rejects.toThrow('down');
    api.failSends = false;
    expect(await p.tick()).toBe(0); // backing off
    clock.advance(10_000);
    expect(await p.tick()).toBe(1);
    expect(await p.tick()).toBe(0);
  });

  test('does not push to a user without access, and unlinks revoked links', async () => {
    const p = pusher();
    await p.tick();
    await login();
    clock.advance(1000);
    core.users.revokeToken(core.users.list()[0]!.id, adminTokenId);
    const id = insertWatch(core.db, { state: 'needs_you' });
    core.db
      .prepare(
        "INSERT INTO needs_you_events (watch_id, reason, created_at, teams_status) VALUES (?, 'r', ?, 'pending')",
      )
      .run(id, clock.now());
    api.sent = [];
    expect(await p.tick()).toBe(0);
    expect(store.link(TG)).toBeNull();
  });
});

describe('runner and configuration', () => {
  test('stays off unless enabled and configured', () => {
    const base = { db: core.db, services: services(), log: () => {} };
    expect(createTelegramBot({ ...base, config: testConfig() })).toBeNull();
    expect(
      createTelegramBot({
        ...base,
        config: testConfig({ telegram: { enabled: false, tokenEnv: 'X', dashboardUrl: 'http://d' } }),
      }),
    ).toBeNull();
    const enabled = testConfig({
      telegram: { enabled: true, tokenEnv: 'AUTOMATOR_TELEGRAM_BOT_TOKEN', dashboardUrl: 'http://d' },
    });
    expect(createTelegramBot({ ...base, config: enabled, env: {} })).toBeNull();
    expect(createTelegramBot({ ...base, config: enabled, env: { AUTOMATOR_TELEGRAM_BOT_TOKEN: 'x' } })).not.toBeNull();
  });

  test('retries polling with backoff, then handles updates and persists the offset', async () => {
    const logs: string[] = [];
    const sleeps: number[] = [];
    api.polls = [
      new TelegramApiError('getUpdates: down', 502),
      new TelegramApiError('getUpdates: down', 502),
      [
        {
          update_id: 41,
          message: { message_id: 1, chat: { id: CHAT, type: 'private' }, from: { id: TG }, text: '/help' },
        },
      ],
    ];
    const runner = createTelegramRunner({
      db: core.db,
      services: services(),
      dashboardUrl: 'http://d',
      api,
      log: (l) => logs.push(l),
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 1));
      },
      pushEveryMs: 1_000_000,
    });
    runner.start();
    await new Promise((r) => setTimeout(r, 100));
    await runner.stop();
    expect(sleeps.filter((ms) => ms < 10_000)).toEqual([1000, 2000]);
    expect(logs.filter((l) => l.includes('polling failed'))).toHaveLength(2);
    expect(store.getState('update_offset')).toBe('42');
    expect(api.texts()).toContain('Send /login');
  });
});

describe('splitMessage', () => {
  test('keeps every part within the limit and loses nothing', () => {
    const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= TELEGRAM_LIMIT)).toBe(true);
    expect(parts.join('\n')).toBe(text);
    expect(splitMessage('x'.repeat(10_000)).every((p) => p.length <= TELEGRAM_LIMIT)).toBe(true);
  });
});
