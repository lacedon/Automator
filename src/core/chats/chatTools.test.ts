import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { tempDb } from '../../../test/helpers/db';
import { toChatSession } from '../db/rows';
import { ChatSessionService } from './chatSessionService';
import { ASK_USER_TOOL, MIN_WAKEUP_MS, QUESTION_TIMEOUT_REPLY, SCHEDULE_WAKEUP_TOOL } from './chatToolDefs';
import { askUser, CHAT_TOOLS, scheduleWakeup, type ChatToolContext } from './chatTools';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NONCE = 'abc123';

function setup(questionWaitMs = 600_000) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const config = testConfig({ runs: { questionWaitMs } });
  const session = new ChatSessionService(t.db, clock).create({
    repository: 'pages',
    provider: 'pi',
    model: 'm',
    agentId: null,
  });
  t.db.prepare('UPDATE chat_sessions SET mcp_nonce = ? WHERE id = ?').run(NONCE, session.id);
  const runId = Number(
    t.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, provider, queued_at, started_at, isolation, chat_session_id)
         VALUES (NULL, 'pages', 'running', 'adhoc', 0, 'ad-hoc', 'm', 'pi', ?, ?, 'copy', ?)`,
      )
      .run(clock.now(), clock.now(), session.id).lastInsertRowid,
  );
  const ctx: ChatToolContext = {
    db: t.db,
    clock,
    sessionId: session.id,
    nonce: NONCE,
    configFor: () => config,
    pollMs: 2,
  };
  const row = () => toChatSession(t.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id));
  return { ...t, clock, session, runId, ctx, row };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return;
    await sleep(2);
  }
  throw new Error('timed out');
}

describe('ask_user', () => {
  test('the tool schema matches the plan', () => {
    expect(ASK_USER_TOOL.name).toBe('ask_user');
    expect(ASK_USER_TOOL.inputSchema.required).toEqual(['question']);
    expect(QUESTION_TIMEOUT_REPLY).toBe('No answer yet. Stop and wait for the user');
  });

  test('validates input against the schema', async () => {
    const s = setup();
    for (const input of [
      null,
      {},
      { question: '' },
      { question: 'q', options: ['only one'] },
      { question: 'q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) },
      { question: 'q', options: ['a', ''] },
      { question: 'q', extra: true },
      { question: 'x'.repeat(2001) },
    ]) {
      const result = await askUser(s.ctx, input);
      expect(result.isError).toBe(true);
    }
    expect(s.row().question).toBeNull();
  });

  test('returns the answer', async () => {
    const s = setup();
    const pending = askUser(s.ctx, { question: 'Which color?', options: ['Red', 'Blue'] });
    await until(() => s.row().question !== null);
    expect(s.row().question).toMatchObject({
      text: 'Which color?',
      options: ['Red', 'Blue'],
      source: 'automator',
      runId: s.runId,
      expiresAt: s.clock.now() + 600_000,
    });
    // What the dashboard's answerQuestion stores for an in-turn answer.
    s.db.prepare('UPDATE chat_sessions SET question_answer = ? WHERE id = ?').run('Blue', s.session.id);
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'Blue' }] });
    expect(s.row().question).toBeNull();
  });

  test('returns the timeout reply after questionWaitMs and leaves the question pending', async () => {
    const s = setup(60_000);
    const pending = askUser(s.ctx, { question: 'Free text?' });
    await until(() => s.row().question !== null);
    expect(s.row().question).toMatchObject({ options: null, expiresAt: s.clock.now() + 60_000 });
    s.clock.advance(60_000);
    expect(await pending).toEqual({ content: [{ type: 'text', text: QUESTION_TIMEOUT_REPLY }] });
    expect(s.row().question).toMatchObject({ expiredAt: s.clock.now() });
  });

  test('a second ask_user while one is pending is a tool error', async () => {
    const s = setup();
    const first = askUser(s.ctx, { question: 'One?' });
    await until(() => s.row().question !== null);
    const second = await askUser(s.ctx, { question: 'Two?' });
    expect(second.isError).toBe(true);
    s.clock.advance(600_000);
    await first;
  });

  test('rejects a wrong nonce, a closed session and a session without a running turn', async () => {
    const s = setup();
    expect((await askUser({ ...s.ctx, nonce: 'nope' }, { question: 'q' })).isError).toBe(true);
    expect((await askUser({ ...s.ctx, sessionId: 9999 }, { question: 'q' })).isError).toBe(true);
    s.db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(s.runId);
    expect((await askUser(s.ctx, { question: 'q' })).isError).toBe(true);
    s.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(s.runId);
    s.db.prepare('UPDATE chat_sessions SET closed_at = ? WHERE id = ?').run(s.clock.now(), s.session.id);
    expect((await askUser(s.ctx, { question: 'q' })).isError).toBe(true);
    expect(s.row().question).toBeNull();
  });

  test('an aborted wait returns an error and leaves the question for the turn end to expire', async () => {
    const s = setup();
    const controller = new AbortController();
    const pending = askUser({ ...s.ctx, signal: controller.signal }, { question: 'q' });
    await until(() => s.row().question !== null);
    controller.abort();
    expect((await pending).isError).toBe(true);
  });

  test('polling while pending takes no write transaction', async () => {
    const s = setup();
    let transactions = 0;
    const original = s.db.transaction.bind(s.db);
    s.db.transaction = ((fn: never) => {
      transactions += 1;
      return original(fn);
    }) as typeof s.db.transaction;
    const pending = askUser(s.ctx, { question: 'q' });
    await until(() => s.row().question !== null);
    const afterOpen = transactions;
    await sleep(40); // many polls at pollMs 2
    expect(transactions).toBe(afterOpen);
    s.db.prepare('UPDATE chat_sessions SET question_answer = ? WHERE id = ?').run('Blue', s.session.id);
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'Blue' }] });
    expect(transactions).toBe(afterOpen + 1); // exactly the settle
  });

  test('a cancelled call stops polling and cannot consume a later answer', async () => {
    const s = setup();
    const controller = new AbortController();
    const pending = askUser({ ...s.ctx, signal: controller.signal }, { question: 'q' });
    await until(() => s.row().question !== null);
    controller.abort();
    expect((await pending).isError).toBe(true);
    s.db.prepare('UPDATE chat_sessions SET question_answer = ? WHERE id = ?').run('late', s.session.id);
    await sleep(20);
    expect(s.row().question).not.toBeNull(); // still there for the next turn
    expect(s.db.prepare('SELECT question_answer AS a FROM chat_sessions').get()).toEqual({ a: 'late' });
  });

  test('reports progress while waiting', async () => {
    const s = setup();
    const messages: string[] = [];
    const pending = askUser(
      { ...s.ctx, progressEveryMs: 30_000, onProgress: (message) => messages.push(message) },
      { question: 'q' },
    );
    await until(() => s.row().question !== null);
    s.clock.advance(30_000);
    await until(() => messages.length === 1);
    s.clock.advance(600_000);
    await pending;
    expect(messages[0]).toMatch(/waiting/i);
  });
});

describe('schedule_wakeup', () => {
  const iso = (t: number) => new Date(t).toISOString();

  test('is registered with the schema from the plan', () => {
    expect(SCHEDULE_WAKEUP_TOOL.name).toBe('schedule_wakeup');
    expect(SCHEDULE_WAKEUP_TOOL.inputSchema.required).toEqual(['message']);
    expect(MIN_WAKEUP_MS).toBe(60_000);
    expect(CHAT_TOOLS.map((tool) => tool.definition.name)).toEqual(['ask_user', 'schedule_wakeup']);
  });

  test('schedule_wakeup accepts a delay or an absolute time', async () => {
    const s = setup();
    const now = s.clock.now();
    const byDelay = await scheduleWakeup(s.ctx, { delay: '15m', message: 'check the build' });
    expect(byDelay.isError).toBeUndefined();
    expect(byDelay.content[0]!.text).toContain(`Wake-up scheduled for ${iso(now + 900_000)}`);
    expect(s.row().timer).toEqual({ fireAt: now + 900_000, message: 'check the build', createdAt: now });

    const at = iso(now + 2 * 3_600_000);
    const byTime = await scheduleWakeup(s.ctx, { at, message: 'later' });
    expect(byTime.isError).toBeUndefined();
    expect(s.row().timer).toEqual({ fireAt: now + 2 * 3_600_000, message: 'later', createdAt: now });
  });

  test('rejects delays under one minute, past or near times, both or neither fields', async () => {
    const s = setup();
    const now = s.clock.now();
    for (const input of [
      { delay: '59s', message: 'm' },
      { delay: '0m', message: 'm' },
      { delay: 'soon', message: 'm' },
      { delay: '5m', at: iso(now + 600_000), message: 'm' },
      { message: 'm' },
      { at: iso(now - 600_000), message: 'm' },
      { at: iso(now + 30_000), message: 'm' },
      { at: 'tomorrow', message: 'm' },
      { delay: '5m', message: '' },
      { delay: '5m', message: 'x'.repeat(2001) },
      { delay: '5m', message: 'm', extra: 1 },
      null,
    ]) {
      const result = await scheduleWakeup(s.ctx, input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
    }
    expect(s.row().timer).toBeNull();
    // exactly the minimum is accepted
    expect((await scheduleWakeup(s.ctx, { delay: '1m', message: 'm' })).isError).toBeUndefined();
  });

  test('a new wake-up replaces the pending one and says so', async () => {
    const s = setup();
    const first = await scheduleWakeup(s.ctx, { delay: '10m', message: 'one' });
    expect(first.content[0]!.text).not.toContain('replaced');
    const second = await scheduleWakeup(s.ctx, { delay: '20m', message: 'two' });
    expect(second.content[0]!.text).toContain('(replaced the previous one)');
    expect(s.row().timer).toMatchObject({ message: 'two', fireAt: s.clock.now() + 20 * 60_000 });
    expect(s.db.prepare('SELECT count(*) AS n FROM chat_sessions WHERE timer_fire_at IS NOT NULL').get()).toEqual({
      n: 1,
    });
  });

  test('a rejected call keeps the pending timer', async () => {
    const s = setup();
    await scheduleWakeup(s.ctx, { delay: '10m', message: 'one' });
    expect((await scheduleWakeup(s.ctx, { delay: '5s', message: 'two' })).isError).toBe(true);
    expect(s.row().timer).toMatchObject({ message: 'one' });
  });

  test('reports the first firing time inside working hours', async () => {
    const s = setup();
    // Wednesday 10:00 + 12h = 22:00, outside 08:00-19:00; the next window opens Thursday 08:00.
    const result = await scheduleWakeup(s.ctx, { delay: '12h', message: 'night' });
    const nextWindow = new Date(2026, 9, 22, 8, 0).getTime();
    expect(result.content[0]!.text).toContain(`(first run within working hours: ${iso(nextWindow)})`);
    expect(s.row().timer!.fireAt).toBe(s.clock.now() + 12 * 3_600_000); // the requested time is what is stored
  });

  test('rejects a closed session or wrong nonce', async () => {
    const s = setup();
    expect((await scheduleWakeup({ ...s.ctx, nonce: 'nope' }, { delay: '5m', message: 'm' })).isError).toBe(true);
    expect((await scheduleWakeup({ ...s.ctx, sessionId: 9999 }, { delay: '5m', message: 'm' })).isError).toBe(true);
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = ? WHERE id = ?').run(s.clock.now(), s.session.id);
    expect((await scheduleWakeup(s.ctx, { delay: '5m', message: 'm' })).isError).toBe(true);
    s.db
      .prepare('UPDATE chat_sessions SET close_requested_at = NULL, closed_at = ? WHERE id = ?')
      .run(s.clock.now(), s.session.id);
    expect((await scheduleWakeup(s.ctx, { delay: '5m', message: 'm' })).isError).toBe(true);
    expect(s.row().timer).toBeNull();
  });
});
