import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import type { Config } from '../config/schema';
import { toRun } from '../db/rows';
import type { ChatSession, Run } from '../domain/types';
import { DataDir } from '../files/dataDir';
import type { ProviderExit } from '../runs/providerLauncher';
import { ChatSessionService } from './chatSessionService';
import {
  DriverError,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type SessionStartOptions,
  type ToolPolicy,
} from './drivers/sessionDriver';
import { ChatSessionManager } from './sessionManager';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const open: ToolPolicy = { allowAll: true, allowed: [], blocked: [], denyTools: [] };

class FakeHandle implements SessionHandle {
  pid: number;
  sent: string[] = [];
  cancelled = 0;
  stopped = false;
  killed = false;
  private listeners = new Set<(event: SessionEvent) => void>();
  ready: Promise<{ providerSessionId: string }>;
  exited: Promise<ProviderExit>;
  private resolveExit!: (exit: ProviderExit) => void;

  constructor(
    readonly options: SessionStartOptions,
    n: number,
    private readonly behaviour: FakeBehaviour,
  ) {
    this.pid = 40_000 + n;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.ready = behaviour.readyError
      ? Promise.reject(new DriverError(behaviour.readyError))
      : behaviour.readyNever
        ? new Promise(() => {})
        : Promise.resolve({ providerSessionId: options.providerSessionId ?? `prov-${n}` });
    this.ready.catch(() => {});
    if (!behaviour.readyError && !behaviour.readyNever) {
      const id = options.providerSessionId ?? `prov-${n}`;
      queueMicrotask(() => this.emit({ type: 'session', providerSessionId: id }));
    }
  }

  emit(event: SessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: string): Promise<void> {
    this.sent.push(message);
    queueMicrotask(() => this.behaviour.onSend(this, message));
    return Promise.resolve();
  }

  endTurn(): void {
    this.emit({ type: 'turn-end', stopReason: 'end_turn' });
  }

  crash(code = 9): void {
    this.emit({
      type: 'turn-end',
      stopReason: 'error',
      error: { code: 'PROVIDER_ERROR', message: `Provider exited with code ${code}.` },
    });
    this.finish({ code, signal: null });
  }

  finish(exit: ProviderExit): void {
    this.emit({ type: 'exit', exit });
    this.resolveExit(exit);
  }

  respond(): void {}
  cancelTurn(): void {
    this.cancelled += 1;
  }
  stop(): Promise<ProviderExit> {
    this.stopped = true;
    if (!this.behaviour.stopHangs) this.finish({ code: 0, signal: null });
    return this.exited;
  }
  kill(): void {
    this.killed = true;
    this.finish({ code: null, signal: 'SIGKILL' });
  }
}

type FakeBehaviour = {
  readyError?: { code: string; message: string };
  readyNever?: boolean; // the handshake never completes
  stopHangs?: boolean; // stop() does not end the process until the test calls finish()
  onSend: (handle: FakeHandle, message: string) => void;
};

function fakeDriver(behaviour: Partial<FakeBehaviour> = {}) {
  const handles: FakeHandle[] = [];
  const merged: FakeBehaviour = {
    onSend(handle, message) {
      handle.emit({ type: 'turn-start', prompted: true });
      handle.emit({ type: 'text', delta: `reply to ${message}` });
      handle.endTurn();
    },
    ...behaviour,
  };
  const driver: SessionDriver = {
    provider: 'pi',
    start(options) {
      const handle = new FakeHandle(options, handles.length + 1, merged);
      handles.push(handle);
      return handle;
    },
  };
  return { driver, handles, behaviour: merged };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup(
  options: {
    config?: Partial<Config['runs']>;
    behaviour?: Partial<FakeBehaviour>;
    handshakeTimeoutMs?: number;
  } = {},
) {
  const t = tempDb();
  const clock = fakeClock();
  const config = testConfig({ runs: options.config ?? {} });
  cleanups.push(() => {
    t.cleanup();
    fs.rmSync(config.configDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(config.repositories.pages!.folder, 'README.md'), 'readme');
  fs.writeFileSync(path.join(config.repositories.api!.folder, 'README.md'), 'readme');
  const repositories = testRepositories(t.db, config);
  const dataDir = new DataDir(config.dataDir);
  const sessions = new ChatSessionService(t.db, clock);
  const fake = fakeDriver(options.behaviour);
  const configFor = (repository: string | null): Config => {
    void repository;
    return config;
  };
  const manager = new ChatSessionManager({
    db: t.db,
    clock,
    dataDir,
    drivers: { pi: fake.driver },
    configFor,
    repositories,
    ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    closeRetryMs: 60_000,
  });
  const newRun = (session: ChatSession): Run => {
    const info = t.db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, provider, queued_at, started_at, isolation, chat_session_id)
         VALUES (NULL, ?, 'running', 'adhoc', 0, 'ad-hoc', 'm', 'pi', ?, ?, 'copy', ?)`,
      )
      .run(session.repository, clock.now(), clock.now(), session.id);
    dataDir.ensureRunDir(Number(info.lastInsertRowid));
    return toRun(t.db.prepare('SELECT * FROM runs WHERE id = ?').get(info.lastInsertRowid));
  };
  const newChat = (repository = 'pages') => {
    const session = sessions.create({ repository, provider: 'pi', model: 'm', agentId: null });
    return { session, run: newRun(session) };
  };
  const startOptions = { model: 'm', env: {}, tools: open };
  const turn = (run: Run, session: ChatSession, prompt: string) =>
    manager.startTurn(run, sessions.get(session.id)!, prompt, startOptions);
  return {
    ...t,
    startOptions,
    db: t.db,
    clock,
    config,
    dataDir,
    sessions,
    fake,
    manager,
    newChat,
    newRun,
    turn,
    repositories,
  };
}

describe('ChatSessionManager', () => {
  test('two turns of one Chat reuse one process and one copy', async () => {
    const s = setup();
    const { session, run } = s.newChat();

    const first = await s.turn(run, session, 'one');
    expect(await first.exited).toEqual({ code: 0, signal: null });
    const copy = s.dataDir.chatWorkspacePath(session.id, s.config.repositories.pages!.folder);
    expect(fs.readFileSync(path.join(copy, 'README.md'), 'utf8')).toBe('readme');
    expect(path.relative(s.dataDir.root, copy).split(path.sep).slice(0, 2)).toEqual([
      'chat-workspaces',
      String(session.id),
    ]);
    // The copy is a copy: later turns see work left in it, and it is not copied again.
    fs.writeFileSync(path.join(copy, 'work.txt'), 'in progress');
    expect(s.sessions.get(session.id)).toMatchObject({
      copyPath: copy,
      pid: s.fake.handles[0]!.pid,
      processState: 'idle',
    });

    const second = await s.turn(s.newRun(session), session, 'two');
    expect(await second.exited).toEqual({ code: 0, signal: null });

    expect(s.fake.handles).toHaveLength(1);
    expect(s.fake.handles[0]!.sent).toEqual(['one', 'two']);
    expect(s.fake.handles[0]!.options.cwd).toBe(copy);
    expect(fs.readFileSync(path.join(copy, 'work.txt'), 'utf8')).toBe('in progress');
    expect(s.manager.liveCount()).toBe(1);
  });

  test('the session is busy while a turn runs and the log and sessionDir belong to the Chat', async () => {
    const s = setup({ behaviour: { onSend: () => {} } });
    const { session, run } = s.newChat();

    const turn = await s.turn(run, session, 'hold');
    expect(s.sessions.get(session.id)!.processState).toBe('busy');
    expect(turn.pid).toBe(s.fake.handles[0]!.pid);
    expect(s.fake.handles[0]!.options.logPath).toBe(s.dataDir.chatSessionLogPath(session.id));
    expect(s.fake.handles[0]!.options.sessionDir).toBe(s.dataDir.chatPiSessionsDir());

    s.fake.handles[0]!.endTurn();
    await turn.exited;
    expect(s.sessions.get(session.id)!.processState).toBe('idle');
  });

  test("each turn's events are appended to that Run's transcript.md and lastMessage is the final agent message", async () => {
    const s = setup({
      behaviour: {
        onSend(handle) {
          handle.emit({ type: 'text', delta: 'Hel' });
          handle.emit({ type: 'text', delta: 'lo' });
          handle.emit({ type: 'tool-call', id: 't1', title: 'bash', status: 'in_progress' });
          handle.emit({ type: 'tool-call', id: 't1', title: 'bash', status: 'completed' });
          handle.emit({ type: 'text', delta: 'Final answer' });
          handle.endTurn();
        },
      },
    });
    const { session, run } = s.newChat();

    const turn = await s.turn(run, session, 'go');
    await turn.exited;

    expect(fs.readFileSync(s.dataDir.transcriptPath(run.id), 'utf8')).toBe('Hello\n\nFinal answer');
    expect(turn.lastMessage()).toBe('Final answer');
    const next = s.newRun(session);
    const second = await s.turn(next, session, 'again');
    await second.exited;
    expect(fs.readFileSync(s.dataDir.transcriptPath(run.id), 'utf8')).toBe('Hello\n\nFinal answer');
    expect(fs.existsSync(s.dataDir.transcriptPath(next.id))).toBe(true);
  });

  test('the provider session id from the session event is stored on the chat session', async () => {
    const s = setup();
    const { session, run } = s.newChat();

    const turn = await s.turn(run, session, 'one');
    expect(await turn.sessionId).toBe('prov-1');
    await turn.exited;

    expect(s.sessions.get(session.id)!.providerSessionId).toBe('prov-1');
  });

  test('an idle process is stopped after runs.interactiveIdleMinutes and the next turn resumes by provider session id', async () => {
    const s = setup({ config: { interactiveIdleMinutes: 30 } });
    const { session, run } = s.newChat();
    await (
      await s.turn(run, session, 'one')
    ).exited;

    s.clock.advance(29 * 60_000);
    s.manager.tick();
    await s.manager.drain();
    expect(s.fake.handles[0]!.stopped).toBe(false);

    s.clock.advance(2 * 60_000);
    s.manager.tick();
    await s.manager.drain();
    expect(s.fake.handles[0]!.stopped).toBe(true);
    expect(s.manager.liveCount()).toBe(0);
    expect(s.sessions.get(session.id)).toMatchObject({ processState: 'stopped', pid: null });
    // The copy stays for the next turn.
    expect(fs.existsSync(s.dataDir.chatWorkspaceRoot(session.id))).toBe(true);

    const turn = await s.turn(s.newRun(session), session, 'two');
    await turn.exited;
    expect(s.fake.handles).toHaveLength(2);
    expect(s.fake.handles[1]!.options.providerSessionId).toBe('prov-1');
    expect(s.sessions.get(session.id)!.providerSessionId).toBe('prov-1');
  });

  describe('starting a turn', () => {
    const slowCopy = (ms: number) => {
      const real = fsp.cp.bind(fsp);
      return vi.spyOn(fsp, 'cp').mockImplementation(async (...args: Parameters<typeof fsp.cp>) => {
        await sleep(ms);
        return real(...args);
      });
    };
    const copyingDirs = (s: ReturnType<typeof setup>, id: number) =>
      fs.existsSync(s.dataDir.chatWorkspaceRoot(id))
        ? fs.readdirSync(s.dataDir.chatWorkspaceRoot(id)).filter((name) => name.startsWith('.copying-'))
        : [];

    test('a cancel during the Repository copy ends the start without a process', async () => {
      slowCopy(80);
      const s = setup();
      const { session, run } = s.newChat();
      const abort = new AbortController();

      const pending = s.manager.startTurn(run, s.sessions.get(session.id)!, 'go', {
        ...s.startOptions,
        signal: abort.signal,
      });
      await sleep(10);
      abort.abort();
      const turn = await pending;

      expect((await turn.exited).error?.code).toBe('INTERRUPTED');
      expect(s.fake.handles).toHaveLength(0);
      await sleep(150); // the abandoned copy finishes and cleans up after itself
      expect(copyingDirs(s, session.id)).toEqual([]);
      expect(s.manager.liveCount()).toBe(0);
    });

    test('a cancel during the handshake kills the process and ends the start', async () => {
      const s = setup({ behaviour: { readyNever: true } });
      const { session, run } = s.newChat();
      const abort = new AbortController();

      const pending = s.manager.startTurn(run, s.sessions.get(session.id)!, 'go', {
        ...s.startOptions,
        signal: abort.signal,
      });
      await until(() => s.fake.handles.length === 1, 'the process to start');
      abort.abort();
      const turn = await pending;

      expect((await turn.exited).error?.code).toBe('INTERRUPTED');
      expect(s.fake.handles[0]!.killed).toBe(true);
      expect(s.sessions.get(session.id)).toMatchObject({ processState: 'stopped', pid: null });
      expect(s.manager.liveCount()).toBe(0);
    });

    test('a handshake that never completes is killed after the deadline with a clear error', async () => {
      const s = setup({ behaviour: { readyNever: true }, handshakeTimeoutMs: 30 });
      const { session, run } = s.newChat();

      const turn = await s.turn(run, session, 'go');
      const exit = await turn.exited;

      expect(exit.error).toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(exit.error?.message).toMatch(/did not become ready within/);
      expect(s.fake.handles[0]!.killed).toBe(true);
      expect(s.sessions.get(session.id)).toMatchObject({ processState: 'stopped', pid: null });
      expect(s.manager.liveCount()).toBe(0);
    });

    test('an interrupted copy is never mistaken for a complete one', async () => {
      const failing = vi.spyOn(fsp, 'cp').mockImplementationOnce(async (_source, destination) => {
        fs.mkdirSync(String(destination), { recursive: true });
        fs.writeFileSync(path.join(String(destination), 'partial.txt'), 'half');
        throw new Error('disk full');
      });
      const s = setup();
      const { session, run } = s.newChat();
      const copy = s.dataDir.chatWorkspacePath(session.id, s.config.repositories.pages!.folder);

      const first = await s.turn(run, session, 'one');
      expect((await first.exited).error?.code).toBe('WORKSPACE_COPY_FAILED');
      expect(fs.existsSync(copy)).toBe(false);
      expect(copyingDirs(s, session.id)).toEqual([]);
      expect(s.sessions.get(session.id)!.copyPath).toBeNull();

      failing.mockRestore();
      const second = await s.turn(s.newRun(session), session, 'two');
      expect(await second.exited).toEqual({ code: 0, signal: null });
      expect(fs.readFileSync(path.join(copy, 'README.md'), 'utf8')).toBe('readme');
      expect(fs.existsSync(path.join(copy, 'partial.txt'))).toBe(false);
    });
  });

  test('idle timeout and eviction skip a session whose turn is starting', async () => {
    const s = setup({ config: { interactiveIdleMinutes: 30, maxInteractiveSessions: 1 } });
    const a = s.newChat('pages');
    await (
      await s.turn(a.run, a.session, 'one')
    ).exited;
    s.clock.advance(31 * 60_000);

    // The turn is claimed (starting) but has not reached the process yet: tick must not stop it.
    const second = s.turn(s.newRun(a.session), a.session, 'two');
    s.manager.tick();
    await s.manager.drain();
    expect(s.fake.handles[0]!.stopped).toBe(false);
    await (
      await second
    ).exited;
    expect(s.fake.handles).toHaveLength(1);
    expect(s.fake.handles[0]!.sent).toEqual(['one', 'two']);

    // Another Chat starting at the limit must not evict the session that is about to be used.
    s.clock.advance(31 * 60_000);
    const third = s.turn(s.newRun(a.session), a.session, 'three');
    const b = s.newChat('api');
    const other = s.turn(b.run, b.session, 'other');
    await (
      await third
    ).exited;
    await other;
    expect(s.fake.handles[0]!.sent).toEqual(['one', 'two', 'three']);
  });

  test('processes that are still stopping count toward maxInteractiveSessions', async () => {
    const s = setup({ config: { maxInteractiveSessions: 1 }, behaviour: { stopHangs: true } });
    const a = s.newChat('pages');
    await (
      await s.turn(a.run, a.session, 'one')
    ).exited;
    expect(s.manager.liveCount()).toBe(1);

    const b = s.newChat('api');
    const pending = s.turn(b.run, b.session, 'two');
    await until(() => s.fake.handles[0]!.stopped, 'the eviction');
    await sleep(20);
    expect(s.fake.handles).toHaveLength(1); // the new process waits for the old one to be gone
    expect(s.manager.liveCount()).toBe(1);

    s.fake.handles[0]!.finish({ code: 0, signal: null });
    await (
      await pending
    ).exited;
    expect(s.fake.handles).toHaveLength(2);
  });

  describe('a close that fails', () => {
    test('is logged and retried after a back-off, not on every tick', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const s = setup();
      const { session, run } = s.newChat();
      await (
        await s.turn(run, session, 'one')
      ).exited;
      s.db.prepare('UPDATE runs SET status = ?, ended_at = 1 WHERE id = ?').run('finished', run.id);
      s.db.prepare('UPDATE chat_sessions SET close_requested_at = 1 WHERE id = ?').run(session.id);
      const remove = vi.spyOn(s.dataDir, 'removeChatWorkspace').mockImplementation(() => {
        throw new Error('EBUSY: resource busy');
      });

      s.manager.tick();
      await s.manager.drain();
      s.manager.tick();
      await s.manager.drain();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(s.sessions.get(session.id)!.closedAt).toBeNull();
      expect(fs.readFileSync(s.dataDir.chatSessionLogPath(session.id), 'utf8')).toMatch(
        /closing the chat failed.*EBUSY/,
      );
      expect(error).toHaveBeenCalled();

      s.clock.advance(61_000);
      s.manager.tick();
      await s.manager.drain();
      expect(remove).toHaveBeenCalledTimes(2);

      remove.mockRestore();
      s.clock.advance(61_000);
      s.manager.tick();
      await s.manager.drain();
      expect(s.sessions.get(session.id)!.closedAt).not.toBeNull();
      error.mockRestore();
    });
  });

  test('after a worker restart the next turn starts the process lazily, resumes by session id and keeps the copy', async () => {
    const s = setup();
    const { session, run } = s.newChat();
    await (
      await s.turn(run, session, 'one')
    ).exited;
    const copy = s.dataDir.chatWorkspacePath(session.id, s.config.repositories.pages!.folder);
    fs.writeFileSync(path.join(copy, 'work.txt'), 'in progress');
    // What recoverInterruptedRuns leaves behind: process gone, state stopped, copy and session id kept.
    s.db.prepare("UPDATE chat_sessions SET process_state = 'stopped', pid = NULL WHERE id = ?").run(session.id);
    const restarted = fakeDriver();
    const manager = new ChatSessionManager({
      db: s.db,
      clock: s.clock,
      dataDir: s.dataDir,
      drivers: { pi: restarted.driver },
      configFor: () => s.config,
      repositories: s.repositories,
    });
    expect(manager.liveCount()).toBe(0);

    const turn = await manager.startTurn(s.newRun(session), s.sessions.get(session.id)!, 'two', {
      model: 'm',
      env: {},
      tools: open,
    });
    await turn.exited;

    expect(restarted.handles).toHaveLength(1);
    expect(restarted.handles[0]!.options.providerSessionId).toBe('prov-1');
    expect(restarted.handles[0]!.options.cwd).toBe(copy);
    expect(fs.readFileSync(path.join(copy, 'work.txt'), 'utf8')).toBe('in progress');
  });

  test('starting a session beyond maxInteractiveSessions stops the least-recently-used idle process', async () => {
    const s = setup({ config: { maxInteractiveSessions: 2 } });
    const a = s.newChat();
    const b = s.newChat();
    const c = s.newChat('api');
    await (
      await s.turn(a.run, a.session, 'a')
    ).exited;
    s.clock.advance(1_000);
    await (
      await s.turn(b.run, b.session, 'b')
    ).exited;
    s.clock.advance(1_000);
    // Using A again makes B the least recently used.
    await (
      await s.turn(s.newRun(a.session), a.session, 'a2')
    ).exited;
    s.clock.advance(1_000);

    await (
      await s.turn(c.run, c.session, 'c')
    ).exited;
    await s.manager.drain();

    const [handleA, handleB, handleC] = s.fake.handles;
    expect(handleB!.stopped).toBe(true);
    expect(handleA!.stopped).toBe(false);
    expect(handleC!.stopped).toBe(false);
    expect(s.manager.liveCount()).toBe(2);
    expect(s.sessions.get(b.session.id)).toMatchObject({ processState: 'stopped', pid: null });
  });

  test("the starting Chat's Repository decides the limit", async () => {
    const s = setup({ config: { maxInteractiveSessions: 1 } });
    const apiConfig = structuredClone(s.config);
    apiConfig.runs.maxInteractiveSessions = 5;
    const manager = new ChatSessionManager({
      db: s.db,
      clock: s.clock,
      dataDir: s.dataDir,
      drivers: { pi: s.fake.driver },
      configFor: (repository) => (repository === 'api' ? apiConfig : s.config),
      repositories: s.repositories,
    });
    const start = { model: 'm', env: {}, tools: open };
    const a = s.newChat('pages');
    const b = s.newChat('api');
    const c = s.newChat('pages');
    await (
      await manager.startTurn(a.run, a.session, 'a', start)
    ).exited;
    s.clock.advance(1_000);
    // api allows five live processes, so starting it keeps the pages one.
    await (
      await manager.startTurn(b.run, b.session, 'b', start)
    ).exited;
    await manager.drain();
    expect(s.fake.handles.map((h) => h.stopped)).toEqual([false, false]);

    s.clock.advance(1_000);
    // pages allows one: starting a pages Chat stops idle processes (whatever their Project) until it fits.
    await (
      await manager.startTurn(c.run, c.session, 'c', start)
    ).exited;
    await manager.drain();
    expect(s.fake.handles.map((h) => h.stopped)).toEqual([true, true, false]);
    expect(manager.liveCount()).toBe(1);
  });

  test('busy sessions are never evicted', async () => {
    const s = setup({ config: { maxInteractiveSessions: 1 }, behaviour: { onSend: () => {} } });
    const a = s.newChat();
    const b = s.newChat();
    const turnA = await s.turn(a.run, a.session, 'a');

    const turnB = await s.turn(b.run, b.session, 'b');
    await s.manager.drain();

    expect(s.fake.handles[0]!.stopped).toBe(false);
    expect(s.manager.liveCount()).toBe(2);
    s.fake.handles[0]!.endTurn();
    s.fake.handles[1]!.endTurn();
    await Promise.all([turnA.exited, turnB.exited]);
    await s.manager.drain();
    // The next idle transition evicts down to the limit.
    expect(s.manager.liveCount()).toBe(1);
  });

  test('a close request stops the process, deletes the copy and sets closed_at', async () => {
    const s = setup();
    const { session, run } = s.newChat();
    await (
      await s.turn(run, session, 'one')
    ).exited;
    const copyRoot = s.dataDir.chatWorkspaceRoot(session.id);
    expect(fs.existsSync(copyRoot)).toBe(true);

    s.db.prepare("UPDATE runs SET status = 'finished'").run();
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = ? WHERE id = ?').run(s.clock.now(), session.id);
    s.manager.tick();
    await s.manager.drain();

    expect(s.fake.handles[0]!.stopped).toBe(true);
    expect(fs.existsSync(copyRoot)).toBe(false);
    expect(s.sessions.get(session.id)).toMatchObject({
      closedAt: s.clock.now(),
      processState: 'stopped',
      pid: null,
      copyPath: null,
    });
  });

  test('a close request waits while a turn of the Chat is queued or running', async () => {
    const s = setup({ behaviour: { onSend: () => {} } });
    const { session, run } = s.newChat();
    const turn = await s.turn(run, session, 'long');
    s.db.prepare('UPDATE chat_sessions SET close_requested_at = ? WHERE id = ?').run(s.clock.now(), session.id);

    s.manager.tick();
    await s.manager.drain();
    expect(s.sessions.get(session.id)!.closedAt).toBeNull();

    s.fake.handles[0]!.endTurn();
    await turn.exited;
    s.db.prepare("UPDATE runs SET status = 'finished' WHERE id = ?").run(run.id);
    s.manager.tick();
    await s.manager.drain();
    expect(s.sessions.get(session.id)!.closedAt).not.toBeNull();
  });

  test('stopAll stops every live process', async () => {
    const s = setup();
    const a = s.newChat();
    const b = s.newChat();
    await (
      await s.turn(a.run, a.session, 'a')
    ).exited;
    await (
      await s.turn(b.run, b.session, 'b')
    ).exited;
    expect(s.manager.liveCount()).toBe(2);

    await s.manager.stopAll();

    expect(s.fake.handles.map((h) => h.stopped)).toEqual([true, true]);
    expect(s.manager.liveCount()).toBe(0);
    expect(s.sessions.get(a.session.id)).toMatchObject({ processState: 'stopped', pid: null });
  });

  test('killAll kills every live process immediately', async () => {
    const s = setup();
    const a = s.newChat();
    await (
      await s.turn(a.run, a.session, 'a')
    ).exited;

    s.manager.killAll();

    expect(s.fake.handles[0]!.killed).toBe(true);
  });

  test('a copy failure ends the turn with WORKSPACE_COPY_FAILED', async () => {
    const s = setup();
    const { session, run } = s.newChat();
    fs.rmSync(s.config.repositories.pages!.folder, { recursive: true, force: true });

    const turn = await s.turn(run, session, 'one');

    expect(await turn.exited).toMatchObject({ error: { code: 'WORKSPACE_COPY_FAILED' } });
    expect(s.fake.handles).toHaveLength(0);
  });

  test('a session that cannot start (resume failure) ends the turn with its error and leaves no live process', async () => {
    const s = setup({ behaviour: { readyError: { code: 'SESSION_RESUME_FAILED', message: 'cannot resume' } } });
    const { session, run } = s.newChat();
    s.db.prepare("UPDATE chat_sessions SET provider_session_id = 'gone' WHERE id = ?").run(session.id);

    const turn = await s.turn(run, session, 'one');

    expect(await turn.exited).toMatchObject({ error: { code: 'SESSION_RESUME_FAILED', message: 'cannot resume' } });
    expect(s.manager.liveCount()).toBe(0);
    expect(s.sessions.get(session.id)).toMatchObject({ processState: 'stopped', pid: null });
    expect(s.sessions.get(session.id)!.providerSessionId).toBe('gone');
    expect(s.fake.handles[0]!.killed || s.fake.handles[0]!.stopped).toBe(true);
  });

  test('a missing driver fails the turn with PROVIDER_CAPABILITY_UNSUPPORTED', async () => {
    const s = setup();
    const { session, run } = s.newChat();
    const turn = await new ChatSessionManager({
      db: s.db,
      clock: s.clock,
      dataDir: s.dataDir,
      drivers: {},
      configFor: () => s.config,
      repositories: s.repositories,
    }).startTurn(run, session, 'one', { model: 'm', env: {}, tools: open });

    expect(await turn.exited).toMatchObject({ error: { code: 'PROVIDER_CAPABILITY_UNSUPPORTED' } });
  });

  test('a provider crash mid-turn fails the turn, marks the process stopped, and the next turn restarts it', async () => {
    let crash = true;
    const s = setup({
      behaviour: {
        onSend(handle, message) {
          if (crash) return handle.crash(9);
          handle.emit({ type: 'text', delta: `reply to ${message}` });
          return handle.endTurn();
        },
      },
    });
    const { session, run } = s.newChat();

    const turn = await s.turn(run, session, 'boom');
    expect(await turn.exited).toMatchObject({ error: { code: 'PROVIDER_ERROR' } });
    expect(s.manager.liveCount()).toBe(0);
    expect(s.sessions.get(session.id)).toMatchObject({ processState: 'stopped', pid: null });

    crash = false;
    const next = await s.turn(s.newRun(session), session, 'again');
    expect(await next.exited).toEqual({ code: 0, signal: null });
    expect(s.fake.handles).toHaveLength(2);
    expect(s.fake.handles[1]!.options.providerSessionId).toBe('prov-1');
  });

  test('kill(SIGTERM) cancels the turn and kill(SIGKILL) stops the session process', async () => {
    const s = setup({ behaviour: { onSend: () => {} } });
    const { session, run } = s.newChat();
    const turn = await s.turn(run, session, 'long');

    turn.kill('SIGTERM');
    expect(s.fake.handles[0]!.cancelled).toBe(1);
    expect(s.fake.handles[0]!.killed).toBe(false);

    turn.kill('SIGKILL');
    expect(s.fake.handles[0]!.killed).toBe(true);
    expect(await turn.exited).toMatchObject({ signal: 'SIGKILL' });
    expect(s.sessions.get(session.id)).toMatchObject({ processState: 'stopped', pid: null });
  });

  test('a cancelled turn settles the process back to idle', async () => {
    const s = setup({
      behaviour: {
        onSend(handle) {
          handle.emit({ type: 'turn-end', stopReason: 'cancelled' });
        },
      },
    });
    const { session, run } = s.newChat();
    const turn = await s.turn(run, session, 'long');

    expect(await turn.exited).toMatchObject({
      error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('cancelled') },
    });
    expect(s.sessions.get(session.id)!.processState).toBe('idle');
  });

  test('a second turn of a Chat that is mid-turn is refused', async () => {
    const s = setup({ behaviour: { onSend: () => {} } });
    const { session, run } = s.newChat();
    await s.turn(run, session, 'one');

    await expect(s.turn(s.newRun(session), session, 'two')).rejects.toThrow(/already has a turn/);
  });

  test('an unprompted turn-start is logged only', async () => {
    const s = setup();
    const { session, run } = s.newChat();
    await (
      await s.turn(run, session, 'one')
    ).exited;
    const before = (s.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;

    s.fake.handles[0]!.emit({ type: 'turn-start', prompted: false });
    s.fake.handles[0]!.emit({ type: 'text', delta: 'tick' });

    expect((s.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n).toBe(before);
    expect(fs.readFileSync(s.dataDir.chatSessionLogPath(session.id), 'utf8')).toContain('unprompted turn');
    expect(s.sessions.get(session.id)!.processState).toBe('idle');
  });
});
