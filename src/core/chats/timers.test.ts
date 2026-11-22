import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import { openDb, type Database } from '../db/open';
import { toChatSession, toRun } from '../db/rows';
import type { Clock } from '../domain/types';
import { isWithinWorkingHours } from '../domain/schedule';
import { DataDir } from '../files/dataDir';
import { RepositoryService } from '../repositories/repositoryService';
import { QueueService } from '../queue/queueService';
import { ChatSessionService } from './chatSessionService';
import { cancelTimer, fireDueChatTimers, nextFiringTime, setTimer } from './timers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MIN = 60_000;
const config = () => testConfig();

function queueFor(db: Database, clock: Clock, file: string, repositories = new RepositoryService(db, config())) {
  return new QueueService(
    db,
    clock,
    new DataDir(path.dirname(file)),
    config(),
    repositories,
    new ChatSessionService(db, clock),
  );
}

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const cfg = config();
  const queue = queueFor(t.db, clock, t.file, testRepositories(t.db, cfg));
  const session = new ChatSessionService(t.db, clock).create({
    repository: 'pages',
    provider: 'pi',
    model: 'm',
    agentId: null,
  });
  const insertRun = (status: string, parent: number | null) =>
    Number(
      t.db
        .prepare(
          `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, model, provider, queued_at, isolation, chat_session_id, parent_run_id)
           VALUES (NULL, 'pages', ?, 'adhoc', 0, 'ad-hoc', 'hi', 'm', 'pi', ?, 'copy', ?, ?)`,
        )
        .run(status, clock.now(), session.id, parent).lastInsertRowid,
    );
  const root = insertRun('finished', null);
  const row = () => toChatSession(t.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id));
  const fire = () => fireDueChatTimers({ db: t.db, clock, queue, configFor: () => cfg });
  const runs = () => t.db.prepare('SELECT * FROM runs ORDER BY id').all().map(toRun);
  return { ...t, clock, cfg, queue, session, root, insertRun, row, fire, runs };
}

describe('nextFiringTime', () => {
  const hours = config().schedule.workingHours; // Mon-Fri 08:00-19:00
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // Expectations are built with the local-time Date constructor, so they hold in any zone; the zones below add DST.
  test.each(['UTC', 'Europe/Berlin', 'America/New_York'])(
    'nextFiringTime skips nights and non-working days (%s)',
    (tz) => {
      process.env.TZ = tz;
      const wed10 = new Date(2026, 9, 21, 10, 0).getTime();
      expect(nextFiringTime(wed10, hours)).toBe(wed10);
      expect(nextFiringTime(new Date(2026, 9, 21, 22, 0).getTime(), hours)).toBe(new Date(2026, 9, 22, 8, 0).getTime());
      expect(nextFiringTime(new Date(2026, 9, 21, 5, 0).getTime(), hours)).toBe(new Date(2026, 9, 21, 8, 0).getTime());
      expect(nextFiringTime(new Date(2026, 9, 23, 20, 0).getTime(), hours)).toBe(new Date(2026, 9, 26, 8, 0).getTime());
      expect(nextFiringTime(new Date(2026, 9, 24, 12, 0).getTime(), hours)).toBe(new Date(2026, 9, 26, 8, 0).getTime());
    },
  );

  // Friday evening before a clock change (EU 29 Mar and 25 Oct 2026, US 8 Mar and 1 Nov 2026): Monday 08:00 local.
  const changes: [string, [number, number], [number, number]][] = [
    ['Europe/Berlin', [2, 27], [2, 30]],
    ['Europe/Berlin', [9, 23], [9, 26]],
    ['America/New_York', [2, 6], [2, 9]],
    ['America/New_York', [9, 30], [10, 2]],
  ];
  test.each(changes)('nextFiringTime across a DST change (%s)', (tz, friday, monday) => {
    process.env.TZ = tz;
    expect(nextFiringTime(new Date(2026, friday[0], friday[1], 20, 0).getTime(), hours)).toBe(
      new Date(2026, monday[0], monday[1], 8, 0).getTime(),
    );
  });

  test('a window start inside the skipped spring-forward hour still lands inside the window', () => {
    process.env.TZ = 'Europe/Berlin';
    const sundays = { days: [0], start: '02:30', end: '19:00' };
    const from = new Date(2026, 2, 28, 12, 0).getTime(); // Saturday
    const result = nextFiringTime(from, sundays)!;
    expect(result).toBeGreaterThan(from);
    expect(result - from).toBeLessThan(26 * 3_600_000);
    expect(isWithinWorkingHours(result, sundays)).toBe(true);
  });

  test('hours that define no window return null instead of pretending to fire', () => {
    expect(nextFiringTime(Date.now(), { days: [1], start: '10:00', end: '10:00' })).toBeNull();
  });
});

describe('setTimer / cancelTimer', () => {
  test('replaces the pending timer and returns it; cancel clears only that Chat', () => {
    const s = setup();
    const other = new ChatSessionService(s.db, s.clock).create({
      repository: 'pages',
      provider: 'pi',
      model: 'm',
      agentId: null,
    });
    expect(setTimer(s.db, s.session.id, { fireAt: 10, message: 'a', createdAt: 1 })).toEqual({
      stored: true,
      replaced: null,
    });
    setTimer(s.db, other.id, { fireAt: 20, message: 'o', createdAt: 1 });
    expect(setTimer(s.db, s.session.id, { fireAt: 30, message: 'b', createdAt: 2 })).toEqual({
      stored: true,
      replaced: { fireAt: 10, message: 'a', createdAt: 1 },
    });
    expect(cancelTimer(s.db, s.session.id)).toBe(true);
    expect(cancelTimer(s.db, s.session.id)).toBe(false);
    expect(s.row().timer).toBeNull();
    const otherRow = toChatSession(s.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(other.id));
    expect(otherRow.timer).toMatchObject({ message: 'o' });
  });
});

describe('setTimer on a closed Chat', () => {
  test('reports that nothing was stored for a closed, close-requested or unknown Chat', () => {
    const s = setup();
    const timer = { fireAt: 10, message: 'a', createdAt: 1 };
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = 1 WHERE id = ?').run(s.session.id);
    expect(setTimer(s.db, s.session.id, timer)).toEqual({ stored: false, replaced: null });
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = NULL, closed_at = 1 WHERE id = ?').run(s.session.id);
    expect(setTimer(s.db, s.session.id, timer)).toEqual({ stored: false, replaced: null });
    expect(setTimer(s.db, 9999, timer)).toEqual({ stored: false, replaced: null });
    expect(s.row().timer).toBeNull();
  });
});

describe('fireDueChatTimers', () => {
  test('one poisoned Chat does not block the others and its timer is cancelled', () => {
    const s = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poisoned = new ChatSessionService(s.db, s.clock).create({
      repository: 'poison',
      provider: 'pi',
      model: 'm',
      agentId: null,
    });
    s.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, model, provider, queued_at, isolation, chat_session_id)
         VALUES (NULL, 'poison', 'finished', 'adhoc', 0, 'ad-hoc', 'hi', 'm', 'pi', ?, 'copy', ?)`,
      )
      .run(s.clock.now(), poisoned.id);
    setTimer(s.db, poisoned.id, { fireAt: s.clock.now() - 1, message: 'bad', createdAt: 0 });
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'good', createdAt: 0 });
    const configFor = (repository: string | null) => {
      if (repository === 'poison') throw new Error('Unknown Repository "poison"');
      return s.cfg;
    };

    const ids = fireDueChatTimers({ db: s.db, clock: s.clock, queue: s.queue, configFor });

    expect(ids).toHaveLength(1);
    expect(
      s
        .runs()
        .filter((r) => r.trigger === 'timer')
        .map((r) => r.chatSessionId),
    ).toEqual([s.session.id]);
    expect(s.row().timer).toBeNull();
    const poisonedRow = toChatSession(s.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(poisoned.id));
    expect(poisonedRow.timer).toBeNull(); // cancelled, so it does not fail again on every tick
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Chat session #${poisoned.id}`));
    errors.mockRestore();
  });

  test('a Chat whose provider is gated off has its timer cancelled', () => {
    const s = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'm', createdAt: 0 });
    const ids = fireDueChatTimers({
      db: s.db,
      clock: s.clock,
      queue: s.queue,
      configFor: () => s.cfg,
      interactiveSupport: () => ({ supported: false, reason: 'gated' }),
    });
    expect(ids).toEqual([]);
    expect(s.row().timer).toBeNull();
    expect(s.runs().filter((r) => r.trigger === 'timer')).toEqual([]);
    errors.mockRestore();
  });

  test('a busy database is retried on the next tick, not cancelled', () => {
    const s = setup();
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'm', createdAt: 0 });
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(() =>
      fireDueChatTimers({
        db: s.db,
        clock: s.clock,
        queue: s.queue,
        configFor: () => {
          throw busy;
        },
      }),
    ).toThrow('locked');
    expect(s.row().timer).not.toBeNull();
  });

  test('fireDueChatTimers enqueues one timer Run on the tip and clears the timer', () => {
    const s = setup();
    const setAt = s.clock.now();
    setTimer(s.db, s.session.id, { fireAt: setAt + 10 * MIN, message: 'check the build', createdAt: setAt });
    expect(s.fire()).toEqual([]); // not due yet
    s.clock.advance(10 * MIN);
    const ids = s.fire();
    expect(ids).toHaveLength(1);
    const run = s.runs().find((r) => r.id === ids[0])!;
    expect(run).toMatchObject({
      status: 'queued',
      trigger: 'timer',
      reason: 'timer',
      priority: 1,
      parentRunId: s.root,
      chatSessionId: s.session.id,
      provider: 'pi',
      model: 'm',
      repository: 'pages',
    });
    expect(run.adhocPrompt).toBe(`Scheduled wake-up (set ${new Date(setAt).toISOString()}):\n\ncheck the build`);
    expect(s.row().timer).toBeNull();
    expect(s.fire()).toEqual([]);
  });

  test('the timer Run takes the owner of the Chat tip', () => {
    const s = setup();
    const user = Number(
      s.db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('bob', 'x', 1)").run()
        .lastInsertRowid,
    );
    s.db.prepare('UPDATE runs SET owner_user_id = ? WHERE id = ?').run(user, s.root);
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'm', createdAt: 0 });
    const [id] = s.fire();
    expect(s.db.prepare('SELECT owner_user_id AS o FROM runs WHERE id = ?').get(id)).toEqual({ o: user });
  });

  test('does not fire outside working hours', () => {
    const s = setup();
    s.clock.set(Date.parse('2026-10-21T20:00:00'));
    setTimer(s.db, s.session.id, { fireAt: s.clock.now() - MIN, message: 'm', createdAt: 0 });
    expect(s.fire()).toEqual([]);
    expect(s.row().timer).not.toBeNull();
    s.clock.set(new Date(2026, 9, 22, 8, 0).getTime());
    expect(s.fire()).toHaveLength(1);
  });

  test('does not fire for closed or close-requested Chats, or while a turn is queued or running', () => {
    const s = setup();
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'm', createdAt: 0 });

    s.db.prepare('UPDATE chat_sessions SET close_requested_at = 1 WHERE id = ?').run(s.session.id);
    expect(s.fire()).toEqual([]);
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = NULL, closed_at = 1 WHERE id = ?').run(s.session.id);
    expect(s.fire()).toEqual([]);
    s.db.prepare('UPDATE chat_sessions SET closed_at = NULL WHERE id = ?').run(s.session.id);

    let parent = s.root;
    for (const status of ['running', 'queued']) {
      parent = s.insertRun(status, parent);
      expect(s.fire(), status).toEqual([]);
      expect(s.row().timer).not.toBeNull();
      s.db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(parent);
    }
    // Both turns finished: the timer fires on the new tip, not on the first Run.
    const [id] = s.fire();
    expect(toRun(s.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)).parentRunId).toBe(parent);
  });

  test('a pending question does not block a timer', () => {
    const s = setup();
    s.db
      .prepare(
        `UPDATE chat_sessions SET question_text = 'Q?', question_source = 'native', question_request_id = 'r',
           question_asked_at = 1, question_expires_at = 2 WHERE id = ?`,
      )
      .run(s.session.id);
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'm', createdAt: 0 });
    expect(s.fire()).toHaveLength(1);
  });

  test('skips a Chat whose tip is not finished and a timer that is not due', () => {
    const s = setup();
    setTimer(s.db, s.session.id, { fireAt: s.clock.now() + 1, message: 'm', createdAt: 0 });
    expect(s.fire()).toEqual([]);
  });

  test('fires after a simulated restart', () => {
    const s = setup();
    setTimer(s.db, s.session.id, {
      fireAt: s.clock.now() + 5 * MIN,
      message: 'after restart',
      createdAt: s.clock.now(),
    });
    s.db.close();
    const reopened = openDb(s.file);
    cleanups.push(() => reopened.close());
    const queue = queueFor(reopened, s.clock, s.file);
    s.clock.advance(5 * MIN);
    const ids = fireDueChatTimers({ db: reopened, clock: s.clock, queue, configFor: () => s.cfg });
    expect(ids).toHaveLength(1);
    expect(reopened.prepare('SELECT adhoc_prompt FROM runs WHERE id = ?').get(ids[0])).toEqual({
      adhoc_prompt: expect.stringContaining('after restart'),
    });
  });

  test('concurrent ticks cannot enqueue twice', () => {
    const s = setup();
    setTimer(s.db, s.session.id, { fireAt: s.clock.now(), message: 'm', createdAt: 0 });
    const second = openDb(s.file);
    cleanups.push(() => second.close());
    const queue2 = queueFor(second, s.clock, s.file);
    const a = s.fire();
    const b = fireDueChatTimers({ db: second, clock: s.clock, queue: queue2, configFor: () => s.cfg });
    expect(a.length + b.length).toBe(1);
    expect(s.runs().filter((r) => r.trigger === 'timer')).toHaveLength(1);
  });
});
