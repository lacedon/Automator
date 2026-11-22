import { afterEach, describe, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { ChatSessionService } from './chatSessionService';
import { INTERACTIVE_CAPABILITIES, interactiveSupport } from './capabilities';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  return { db: t.db, service: new ChatSessionService(t.db, { now: () => 1_000 }) };
}

function insertRun(db: ReturnType<typeof setup>['db'], sessionId: number | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at, chat_session_id)
         VALUES (NULL, 'pages', 'queued', 'adhoc', 0, 'ad-hoc', 'm', 1, ?)`,
      )
      .run(sessionId).lastInsertRowid,
  );
}

describe('ChatSessionService', () => {
  test('creates, reads and links sessions to Runs', () => {
    const { db, service } = setup();
    const session = service.create({ repository: 'pages', provider: 'pi', model: 'm', agentId: null });
    expect(session).toMatchObject({ mode: 'interactive', createdAt: 1_000, closedAt: null, providerSessionId: null });
    expect(service.get(session.id)).toEqual(session);
    expect(service.get(999)).toBeNull();
    const interactive = insertRun(db, session.id);
    const plain = insertRun(db, null);
    expect(service.forRun(interactive)).toEqual(session);
    expect(service.forRun(plain)).toBeNull();
    expect(service.modeOfRun(interactive)).toBe('interactive');
    expect(service.modeOfRun(plain)).toBe('follow-up');
  });
});

describe('interactive capabilities', () => {
  test('every provider is unsupported with a reason in this version', () => {
    for (const provider of Object.keys(INTERACTIVE_CAPABILITIES) as (keyof typeof INTERACTIVE_CAPABILITIES)[]) {
      const support = interactiveSupport(provider);
      expect(support.supported).toBe(false);
      expect(support.reason).toBeTruthy();
    }
  });
});
