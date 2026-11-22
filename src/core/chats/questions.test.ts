import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import { openDb } from '../db/open';
import { toChatSession } from '../db/rows';
import { DataDir } from '../files/dataDir';
import { MAX_FOLLOW_UP_CHARS, QueueService } from '../queue/queueService';
import { ChatSessionService } from './chatSessionService';
import {
  answerQuestion,
  expireOrphanedQuestions,
  expireQuestionsOfRun,
  openQuestion,
  settleQuestion,
} from './questions';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const WAIT_MS = 600_000;

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const config = testConfig();
  const sessions = new ChatSessionService(t.db, clock);
  const queue = new QueueService(
    t.db,
    clock,
    new DataDir(path.dirname(t.file)),
    config,
    testRepositories(t.db, config),
    sessions,
  );
  const session = sessions.create({ repository: 'pages', provider: 'pi', model: 'm', agentId: null });
  const insertRun = (status: 'running' | 'finished', parent: number | null = null) =>
    Number(
      t.db
        .prepare(
          `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, provider, queued_at, started_at, isolation, chat_session_id, parent_run_id)
           VALUES (NULL, 'pages', ?, 'adhoc', 0, 'ad-hoc', 'm', 'pi', ?, ?, 'copy', ?, ?)`,
        )
        .run(status, clock.now(), clock.now(), session.id, parent).lastInsertRowid,
    );
  const runId = insertRun('running');
  const ask = (overrides: Partial<Parameters<typeof openQuestion>[1]> = {}) =>
    openQuestion(t.db, {
      sessionId: session.id,
      runId,
      text: 'Which color?',
      options: ['Red', 'Blue'],
      source: 'automator',
      requestId: 'q1',
      now: clock.now(),
      waitMs: WAIT_MS,
      ...overrides,
    });
  const row = () => toChatSession(t.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id));
  const answer = (text: string, run = runId) =>
    answerQuestion(t.db, queue, { runId: run, answer: text, now: clock.now() });
  const queuedRuns = () =>
    t.db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY id").all() as Record<string, unknown>[];
  const finish = (id: number) =>
    t.db.prepare("UPDATE runs SET status = 'finished', ended_at = ? WHERE id = ?").run(clock.now(), id);
  return { ...t, clock, queue, session, runId, ask, row, answer, queuedRuns, finish, insertRun };
}

describe('questions', () => {
  test('question text and options are capped for every source', () => {
    for (const source of ['automator', 'native'] as const) {
      const s = setup();
      const opened = s.ask({
        source,
        text: 'q'.repeat(5000),
        options: Array.from({ length: 15 }, (_, i) => `${i}${'o'.repeat(500)}`),
      });
      if (!opened.ok) throw new Error('open failed');
      expect(opened.value.text).toHaveLength(2000);
      expect(opened.value.options).toHaveLength(10);
      expect(opened.value.options!.every((option) => option.length === 200)).toBe(true);
      const stored = s.row().question!;
      expect(stored.text).toHaveLength(2000);
      expect(stored.options).toHaveLength(10);
      // The framing of the later answer turn uses the capped text.
      s.finish(s.runId);
      expireQuestionsOfRun(s.db, s.queue, s.runId, s.clock.now());
      s.answer('A');
      expect((s.queuedRuns()[0]!.adhoc_prompt as string).length).toBeLessThan(2100);
    }
  });

  test('opening a question while one is pending is rejected', () => {
    const s = setup();
    expect(s.ask()).toMatchObject({
      ok: true,
      value: { text: 'Which color?', options: ['Red', 'Blue'], expiresAt: s.clock.now() + WAIT_MS, expiredAt: null },
    });
    expect(s.ask({ requestId: 'q2', text: 'Another?' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.row().question).toMatchObject({ requestId: 'q1', runId: s.runId, source: 'automator' });
  });

  test('a question whose turn was told to stop is replaced by a new one', () => {
    const s = setup();
    s.ask();
    s.clock.advance(WAIT_MS);
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'expired' });
    expect(s.ask({ requestId: 'q2', text: 'Newer?' })).toMatchObject({ ok: true });
    expect(s.row().question).toMatchObject({ requestId: 'q2', text: 'Newer?', expiredAt: null });
  });

  test('opening a question on a closed Chat is rejected', () => {
    const s = setup();
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = ? WHERE id = ?').run(s.clock.now(), s.session.id);
    expect(s.ask()).toMatchObject({ ok: false });
  });

  test('an in-time answer is delivered exactly once', () => {
    const s = setup();
    s.ask();
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'pending' });
    expect(s.answer('  Blue ')).toEqual({ ok: true, value: { delivered: 'in-turn' } });
    expect(s.answer('Red')).toMatchObject({ ok: false });
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'answered', text: 'Blue' });
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'gone' });
    expect(s.row().question).toBeNull();
    expect(s.queuedRuns()).toHaveLength(0);
  });

  test('settling a different request id is gone', () => {
    const s = setup();
    s.ask();
    expect(settleQuestion(s.db, s.session.id, 'other', s.clock.now())).toEqual({ kind: 'gone' });
    expect(s.row().question).not.toBeNull();
  });

  test('timeout marks the question expired only when unanswered', () => {
    const s = setup();
    s.ask();
    s.clock.advance(WAIT_MS - 1);
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'pending' });
    s.clock.advance(1);
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'expired' });
    expect(s.row().question).toMatchObject({ expiredAt: s.clock.now() });
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'expired' });
  });

  test('two connections on one file see exactly one outcome whichever of answer and settle goes first', () => {
    // The dashboard and the MCP process are separate processes with their own handles on the same SQLite file.
    const s = setup();
    const waiter = openDb(s.file);
    cleanups.push(() => waiter.close());
    for (let i = 0; i < 20; i += 1) {
      const requestId = `r${i}`;
      s.ask({ requestId });
      s.clock.advance(WAIT_MS); // the answer and the expiry now race
      const dashboardFirst = i % 2 === 0;
      let settled;
      let answered;
      if (dashboardFirst) {
        answered = s.answer(`a${i}`);
        settled = settleQuestion(waiter, s.session.id, requestId, s.clock.now());
      } else {
        settled = settleQuestion(waiter, s.session.id, requestId, s.clock.now());
        answered = s.answer(`a${i}`);
      }
      const queued = s
        .queuedRuns()
        .filter((run) => run.adhoc_prompt === `Answer to your earlier question "Which color?":\n\na${i}`);
      if (dashboardFirst) {
        expect(answered).toEqual({ ok: true, value: { delivered: 'in-turn' } });
        expect(settled).toEqual({ kind: 'answered', text: `a${i}` });
        expect(queued).toHaveLength(0);
      } else {
        expect(settled).toEqual({ kind: 'expired' });
        expect(answered).toMatchObject({ ok: true, value: { delivered: 'new-turn' } });
        expect(queued).toHaveLength(1);
      }
      expect(s.row().question).toBeNull();
      s.db.prepare("DELETE FROM runs WHERE status = 'queued'").run();
    }
  });

  test('an answer racing the timeout lands in-turn when it comes first', () => {
    const s = setup();
    s.ask();
    s.clock.advance(WAIT_MS + 5);
    expect(s.answer('Blue')).toEqual({ ok: true, value: { delivered: 'in-turn' } });
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'answered', text: 'Blue' });
    expect(s.queuedRuns()).toHaveLength(0);
  });

  test('an answer racing the timeout starts one answer turn when the timeout comes first', () => {
    const s = setup();
    s.ask();
    s.clock.advance(WAIT_MS + 5);
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'expired' });
    const result = s.answer('Blue');
    expect(result).toMatchObject({ ok: true, value: { delivered: 'new-turn' } });
    expect(s.answer('Blue again')).toMatchObject({ ok: false });
    expect(s.queuedRuns()).toHaveLength(1);
    expect(s.queuedRuns()[0]).toMatchObject({
      trigger: 'answer',
      priority: 0,
      chat_session_id: s.session.id,
      parent_run_id: s.runId,
      provider: 'pi',
      model: 'm',
      adhoc_prompt: 'Answer to your earlier question "Which color?":\n\nBlue',
    });
    expect(s.row().question).toBeNull();
    // The waiter that raced sees the question gone.
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'gone' });
  });

  test('an answer after the question’s Run ended starts an answer turn on the Chat tip', () => {
    const s = setup();
    s.ask();
    s.finish(s.runId);
    const later = s.insertRun('finished', s.runId);
    expect(expireQuestionsOfRun(s.db, s.queue, s.runId, s.clock.now())).toBe(true);
    const result = s.answer('Red');
    expect(result).toMatchObject({ ok: true, value: { delivered: 'new-turn' } });
    expect(s.queuedRuns()[0]).toMatchObject({ trigger: 'answer', parent_run_id: later });
  });

  test('an answer while the question has not expired but its Run ended also starts an answer turn', () => {
    const s = setup();
    s.ask();
    s.finish(s.runId);
    expect(s.answer('Red')).toMatchObject({ ok: true, value: { delivered: 'new-turn' } });
  });

  test('an in-turn answer not picked up before the turn ends starts exactly one answer turn', () => {
    const s = setup();
    s.ask();
    expect(s.answer('Blue')).toEqual({ ok: true, value: { delivered: 'in-turn' } });
    // The turn ends (the Run is still running when the manager reports it) before the waiter polled.
    expect(expireQuestionsOfRun(s.db, s.queue, s.runId, s.clock.now())).toBe(true);
    expect(s.queuedRuns()).toHaveLength(1);
    expect(s.queuedRuns()[0]).toMatchObject({
      trigger: 'answer',
      chat_session_id: s.session.id,
      parent_run_id: s.runId,
      adhoc_prompt: 'Answer to your earlier question "Which color?":\n\nBlue',
    });
    expect(s.row().question).toBeNull();
    // Neither a second turn end, recovery, nor a late waiter can queue another.
    expect(expireQuestionsOfRun(s.db, s.queue, s.runId, s.clock.now())).toBe(false);
    s.finish(s.runId);
    expect(expireOrphanedQuestions(s.db, s.queue, s.clock.now())).toBe(false);
    expect(settleQuestion(s.db, s.session.id, 'q1', s.clock.now())).toEqual({ kind: 'gone' });
    expect(s.queuedRuns()).toHaveLength(1);
    // The one-turn-per-Chat claim guard: the answer turn waits while the asking Run is running.
    s.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(s.runId);
    expect(s.queue.claimNext()).toBeNull();
    s.finish(s.runId);
    expect(s.queue.claimNext()).toMatchObject({ trigger: 'answer' });
  });

  test('expiring an unanswered question keeps it pending and queues nothing', () => {
    const s = setup();
    s.ask();
    expect(expireQuestionsOfRun(s.db, s.queue, s.runId, s.clock.now())).toBe(true);
    expect(s.row().question).toMatchObject({ expiredAt: s.clock.now() });
    expect(s.queuedRuns()).toHaveLength(0);
    expect(expireQuestionsOfRun(s.db, s.queue, 999, s.clock.now())).toBe(false);
  });

  test('recovery turns an unpicked in-turn answer into one answer turn', () => {
    const s = setup();
    s.ask();
    s.answer('Blue');
    s.finish(s.runId); // the worker restarted: the Run is no longer running
    expect(expireOrphanedQuestions(s.db, s.queue, s.clock.now())).toBe(true);
    expect(s.queuedRuns()).toHaveLength(1);
    expect(s.queuedRuns()[0]).toMatchObject({ trigger: 'answer', adhoc_prompt: expect.stringContaining('Blue') });
    expect(s.row().question).toBeNull();
    expect(expireOrphanedQuestions(s.db, s.queue, s.clock.now())).toBe(false);
    expect(s.queuedRuns()).toHaveLength(1);
  });

  test('answers are trimmed, required and limited to MAX_FOLLOW_UP_CHARS', () => {
    const s = setup();
    s.ask();
    expect(s.answer('   ')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'answer' } });
    expect(s.answer('x'.repeat(MAX_FOLLOW_UP_CHARS + 1))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'answer' },
    });
    expect(s.row().question).not.toBeNull();
    expect(s.answer('x'.repeat(MAX_FOLLOW_UP_CHARS))).toMatchObject({ ok: true });
  });

  test('answering without a pending question, or on a Run outside an Interactive Chat, is rejected', () => {
    const s = setup();
    expect(s.answer('hi')).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    const plain = Number(
      s.db
        .prepare(
          `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, provider, queued_at)
           VALUES (NULL, 'pages', 'finished', 'adhoc', 0, 'ad-hoc', 'm', 'pi', ?)`,
        )
        .run(s.clock.now()).lastInsertRowid,
    );
    expect(s.answer('hi', plain)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.answer('hi', 12345)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('answering a closed Chat is rejected', () => {
    const s = setup();
    s.ask();
    s.db.prepare('UPDATE chat_sessions SET closed_at = ? WHERE id = ?').run(s.clock.now(), s.session.id);
    expect(s.answer('Blue')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'run' } });
    s.db
      .prepare('UPDATE chat_sessions SET closed_at = NULL, close_requested_at = ? WHERE id = ?')
      .run(s.clock.now(), s.session.id);
    expect(s.answer('Blue')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'run' } });
  });
});
