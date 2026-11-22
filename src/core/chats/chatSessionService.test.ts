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
  test('claude-code and pi are interactive; the other ACP providers are gated off with a reason', () => {
    expect(interactiveSupport('claude-code')).toEqual({ supported: true, reason: null });
    expect(interactiveSupport('pi')).toEqual({ supported: true, reason: null });
    for (const [provider, name] of [
      ['copilot', 'Copilot'],
      ['codex', 'Codex'],
      ['opencode', 'OpenCode'],
    ] as const) {
      expect(interactiveSupport(provider)).toEqual({
        supported: false,
        reason: `Interactive mode is not available for ${name} yet: its ACP session resume is not verified`,
      });
    }
  });

  test('the table matches the provider spike', () => {
    expect(INTERACTIVE_CAPABILITIES['claude-code']).toEqual({
      interactive: true,
      protocol: 'acp',
      resume: true,
      automatorTools: 'mcp',
      nativeQuestions: 'acp-elicitation',
      nativeTimers: true,
      reason: null,
    });
    expect(INTERACTIVE_CAPABILITIES.pi).toEqual({
      interactive: true,
      protocol: 'pi-rpc',
      resume: true,
      automatorTools: 'pi-extension',
      nativeQuestions: 'pi-extension-ui',
      nativeTimers: false,
      reason: null,
    });
  });
});
