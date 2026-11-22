import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConfigFor } from '../config/resolver';
import type { Database } from '../db/open';
import { toChatSession } from '../db/rows';
import type { ChatProcessState, ChatSession, Clock, Run, RunError } from '../domain/types';
import { CHAT_COPYING_PREFIX as COPYING_PREFIX, type DataDir } from '../files/dataDir';
import type { RepositoryService } from '../repositories/repositoryService';
import { createLiveTranscript, reportLiveFailure, type LiveTranscript } from '../runs/liveTranscript';
import type { ProviderExit, RunningProcess } from '../runs/providerLauncher';
import {
  asRunError,
  type SessionDrivers,
  type SessionEvent,
  type SessionHandle,
  type SessionStartOptions,
} from './drivers/sessionDriver';

export interface ChatSessionManagerDeps {
  db: Database;
  clock: Clock;
  dataDir: DataDir;
  drivers: SessionDrivers;
  configFor: ConfigFor;
  repositories: RepositoryService;
  // How long a provider process may take to become ready (initialize + session/new|load) before it is killed.
  handshakeTimeoutMs?: number;
  // How long a failed close waits before it is retried.
  closeRetryMs?: number;
}

export const SESSION_HANDSHAKE_TIMEOUT_MS = 60_000;
export const CLOSE_RETRY_MS = 30_000;

// The turn as the executor supervises it: a process-like handle whose `exited` resolves when the turn settles.
export type TurnHandle = RunningProcess & { lastMessage(): string | null };
// `signal` aborts a turn that is still starting (copying the Repository, spawning, handshaking).
export type TurnStart = Omit<SessionStartOptions, 'cwd' | 'providerSessionId' | 'logPath' | 'sessionDir'> & {
  signal?: AbortSignal;
};

type Turn = {
  runId: number;
  transcript: LiveTranscript;
  hasText: boolean;
  breakBefore: boolean;
  current: string;
  previous: string | null;
  seenTools: Set<string>;
  settle(exit: ProviderExit): void;
};

type Live = {
  id: number;
  repository: string;
  handle: SessionHandle;
  turn: Turn | null;
  lastUsedAt: number;
  stopping: Promise<ProviderExit> | null;
  exited: boolean;
  unpromptedLogged: boolean;
  unsubscribe: () => void;
};

const failure = (error: RunError): TurnHandle => ({
  pid: 0,
  sessionId: Promise.resolve(null),
  exited: Promise.resolve({ code: null, signal: null, error }),
  kill() {},
  lastMessage: () => null,
});

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

class Aborted extends Error {}
class HandshakeTimeout extends Error {}
const ABORTED: RunError = { code: 'INTERRUPTED', message: 'The turn was cancelled before the provider started it' };

// Rejects with Aborted as soon as the signal fires; the underlying work keeps running and must clean up after itself.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new Aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// One long-lived provider process per Interactive Chat, owned by the worker: lazy start and resume by provider
// session id, idle timeout, LRU eviction, close requests, and one working copy per Chat.
export class ChatSessionManager {
  private readonly live = new Map<number, Live>();
  private readonly starting = new Set<number>();
  private readonly closing = new Set<number>();
  private readonly closeRetryAt = new Map<number, number>();
  private readonly copying = new Map<number, Promise<void>>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChatSessionManagerDeps) {}

  liveCount(): number {
    let count = 0;
    for (const live of this.live.values()) if (!live.exited) count += 1; // processes being stopped still hold a slot
    return count;
  }

  private runningCount(): number {
    let count = 0;
    for (const live of this.live.values()) if (!live.exited && live.stopping === null) count += 1;
    return count;
  }

  // Ensures the copy and a live process (starting or resuming it, evicting if needed), sends the prompt, appends the
  // events to the Run's transcript.md, and settles `exited` when the turn ends.
  async startTurn(run: Run, session: ChatSession, prompt: string, turnStart: TurnStart): Promise<TurnHandle> {
    const { signal, ...start } = turnStart;
    const id = session.id;
    if (this.starting.has(id) || this.live.get(id)?.turn != null) {
      throw new Error(`Chat session #${id} already has a turn in flight`);
    }
    this.starting.add(id);
    try {
      const row = this.row(id) ?? session;
      const copy = await this.ensureCopy(row, signal);
      if ('error' in copy) return failure(copy.error);
      const live = await this.ensureLive(row, copy.path, start, signal);
      if ('error' in live) return failure(live.error);
      if (signal?.aborted === true) return failure(ABORTED);
      return await this.beginTurn(live.live, run, prompt);
    } finally {
      this.starting.delete(id);
    }
  }

  // Idle timeout, eviction and close requests. Cheap enough to run on every worker iteration.
  tick(): void {
    const now = this.deps.clock.now();
    for (const live of this.live.values()) {
      if (live.exited || live.stopping !== null || live.turn !== null || this.starting.has(live.id)) continue;
      const idleMs = this.deps.configFor(live.repository).runs.interactiveIdleMinutes * 60_000;
      if (now - live.lastUsedAt >= idleMs) this.stopLive(live);
    }
    this.processCloseRequests();
  }

  async stopAll(): Promise<void> {
    for (const live of this.live.values()) this.stopLive(live);
    await this.drain();
  }

  // Forced exit: no waiting, no database writes beyond what exit handlers do on their own.
  killAll(): void {
    for (const live of this.live.values()) {
      try {
        live.handle.kill();
      } catch {
        // Already gone.
      }
    }
  }

  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => {}).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  private row(id: number): ChatSession | null {
    const row = this.deps.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
    return row === undefined ? null : toChatSession(row);
  }

  private setProcess(id: number, state: ChatProcessState, pid: number | null | undefined = undefined): void {
    const now = this.deps.clock.now();
    if (pid === undefined) {
      this.deps.db
        .prepare('UPDATE chat_sessions SET process_state = ?, last_activity_at = ? WHERE id = ?')
        .run(state, now, id);
    } else {
      this.deps.db
        .prepare('UPDATE chat_sessions SET process_state = ?, pid = ?, last_activity_at = ? WHERE id = ?')
        .run(state, pid, now, id);
    }
  }

  private log(id: number, line: string): void {
    try {
      const file = this.deps.dataDir.chatSessionLogPath(id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date(this.deps.clock.now()).toISOString()} ${line}\n`);
    } catch {
      // The log is best effort.
    }
  }

  // The copy is made in a temporary directory and renamed into place, so an interrupted copy is never mistaken
  // for a complete one. Recovery removes the leftovers.
  private async ensureCopy(
    row: ChatSession,
    signal: AbortSignal | undefined,
  ): Promise<{ path: string } | { error: RunError }> {
    const repository = this.deps.repositories.get(row.repository);
    if (repository === null) {
      return { error: { code: 'REPOSITORY_UNAVAILABLE', message: `Unknown Repository "${row.repository}"` } };
    }
    const copy = row.copyPath ?? this.deps.dataDir.chatWorkspacePath(row.id, repository.folder);
    if (!fs.existsSync(copy)) {
      let copying = this.copying.get(row.id);
      if (copying === undefined) {
        const holder = path.dirname(copy);
        const temp = path.join(holder, `${COPYING_PREFIX}${randomUUID()}`);
        copying = fsp
          .cp(repository.folder, path.join(temp, path.basename(copy)), { recursive: true, verbatimSymlinks: true })
          .then(() => fsp.rename(path.join(temp, path.basename(copy)), copy))
          .finally(async () => {
            this.copying.delete(row.id);
            await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
          });
        this.copying.set(row.id, copying);
        copying.catch(() => {}); // an abandoned copy (cancelled turn) must not become an unhandled rejection
      }
      try {
        await raceAbort(copying, signal);
      } catch (e) {
        if (e instanceof Aborted) return { error: ABORTED };
        return {
          error: { code: 'WORKSPACE_COPY_FAILED', message: `Could not copy the Repository folder: ${errorMessage(e)}` },
        };
      }
    }
    if (row.copyPath !== copy) {
      this.deps.db.prepare('UPDATE chat_sessions SET copy_path = ? WHERE id = ?').run(copy, row.id);
    }
    return { path: copy };
  }

  private async ensureLive(
    row: ChatSession,
    cwd: string,
    start: Omit<TurnStart, 'signal'>,
    signal: AbortSignal | undefined,
  ): Promise<{ live: Live } | { error: RunError }> {
    const existing = this.live.get(row.id);
    if (existing !== undefined && !existing.exited && existing.stopping === null) return { live: existing };
    // A process that is being stopped must be gone before its replacement starts, or both would own the session.
    if (existing?.stopping != null) await existing.stopping.catch(() => {});

    const limit = this.deps.configFor(row.repository).runs.maxInteractiveSessions;
    this.evictFor(limit);
    // Evicted processes hold their slot until they are gone, or the limit would be exceeded while they stop.
    if (this.liveCount() >= limit) {
      await Promise.allSettled(
        [...this.live.values()].flatMap((live) => (live.stopping === null ? [] : [live.stopping])),
      );
    }
    if (signal?.aborted === true) return { error: ABORTED };

    const driver = this.deps.drivers[row.provider];
    if (driver === undefined) {
      return {
        error: {
          code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
          message: `Interactive mode is not available for provider "${row.provider}".`,
        },
      };
    }
    this.setProcess(row.id, 'starting', null);
    let handle: SessionHandle;
    try {
      fs.mkdirSync(path.dirname(this.deps.dataDir.chatSessionLogPath(row.id)), { recursive: true });
      handle = driver.start({
        ...start,
        cwd,
        logPath: this.deps.dataDir.chatSessionLogPath(row.id),
        sessionDir: this.deps.dataDir.chatPiSessionsDir(),
        ...(row.providerSessionId === null ? {} : { providerSessionId: row.providerSessionId }),
      });
    } catch (e) {
      this.setProcess(row.id, 'stopped', null);
      return { error: { code: 'SPAWN_FAILED', message: errorMessage(e) } };
    }
    const live: Live = {
      id: row.id,
      repository: row.repository,
      handle,
      turn: null,
      lastUsedAt: this.deps.clock.now(),
      stopping: null,
      exited: false,
      unpromptedLogged: false,
      unsubscribe: () => {},
    };
    live.unsubscribe = handle.onEvent((event) => this.onEvent(live, event));
    void handle.exited.then(
      (exit) => this.onExited(live, exit),
      () => this.onExited(live, { code: null, signal: null }),
    );
    this.live.set(row.id, live);

    const timeoutMs = this.deps.handshakeTimeoutMs ?? SESSION_HANDSHAKE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HandshakeTimeout()), timeoutMs);
    });
    handle.ready.catch(() => {});
    try {
      const ready = await raceAbort(Promise.race([handle.ready, deadline]), signal);
      if (ready.providerSessionId !== row.providerSessionId) this.storeProviderSession(row.id, ready.providerSessionId);
    } catch (e) {
      const error: RunError =
        e instanceof Aborted
          ? ABORTED
          : e instanceof HandshakeTimeout
            ? {
                code: 'PROVIDER_ERROR',
                message: `The ${row.provider} session did not become ready within ${Math.round(timeoutMs / 1000)} s and was stopped.`,
              }
            : asRunError(e);
      this.log(row.id, `session did not start: ${error.code}: ${error.message}`);
      live.handle.kill();
      this.onExited(live, { code: null, signal: null });
      return { error };
    } finally {
      clearTimeout(timer);
    }
    this.setProcess(row.id, 'idle', handle.pid);
    return { live };
  }

  private storeProviderSession(id: number, providerSessionId: string): void {
    this.deps.db.prepare('UPDATE chat_sessions SET provider_session_id = ? WHERE id = ?').run(providerSessionId, id);
  }

  // Stops idle processes, least recently used first and whatever their Project, until a new one fits.
  // Busy processes are never evicted, so the limit can be exceeded while every live session is mid-turn.
  private evictFor(limit: number): void {
    while (this.runningCount() >= limit) {
      const candidate = [...this.live.values()]
        .filter((live) => !live.exited && live.stopping === null && live.turn === null && !this.starting.has(live.id))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (candidate === undefined) return;
      this.stopLive(candidate);
    }
  }

  private async beginTurn(live: Live, run: Run, prompt: string): Promise<TurnHandle> {
    const transcript = createLiveTranscript(this.deps.dataDir.transcriptPath(run.id), { separator: '' });
    let settle!: (exit: ProviderExit) => void;
    const exited = new Promise<ProviderExit>((resolve) => {
      settle = resolve;
    });
    const turn: Turn = {
      runId: run.id,
      transcript,
      hasText: false,
      breakBefore: false,
      current: '',
      previous: null,
      seenTools: new Set(),
      settle,
    };
    live.turn = turn;
    live.unpromptedLogged = false;
    this.setProcess(live.id, 'busy');
    exited.then(() => {
      transcript.finish(null);
      reportLiveFailure(transcript, this.deps.dataDir.chatSessionLogPath(live.id));
    });
    try {
      await live.handle.send(prompt);
    } catch (e) {
      this.endTurn(live, { code: null, signal: null, error: asRunError(e) });
    }
    return {
      pid: live.handle.pid,
      sessionId: live.handle.ready.then(
        (ready) => ready.providerSessionId,
        () => null,
      ),
      exited,
      kill: (signal) => {
        if (signal === 'SIGTERM') live.handle.cancelTurn();
        else live.handle.kill();
      },
      lastMessage: () => (turn.current !== '' ? turn.current : turn.previous),
    };
  }

  private onEvent(live: Live, event: SessionEvent): void {
    const turn = live.turn;
    switch (event.type) {
      case 'session':
        if (this.row(live.id)?.providerSessionId !== event.providerSessionId) {
          this.storeProviderSession(live.id, event.providerSessionId);
        }
        return;
      case 'turn-start':
        if (!event.prompted && turn === null && !live.unpromptedLogged) {
          live.unpromptedLogged = true;
          this.log(live.id, 'unprompted turn started (not recorded until agent Runs exist)');
        }
        return;
      case 'text':
        if (turn === null || event.delta === '') return;
        turn.transcript.append(turn.breakBefore && turn.hasText ? `\n\n${event.delta}` : event.delta);
        turn.breakBefore = false;
        turn.hasText = true;
        turn.current += event.delta;
        return;
      case 'tool-call':
        if (turn === null || turn.seenTools.has(event.id)) return;
        // A tool call splits the agent's text into messages; the last one is the Run's summary.
        turn.seenTools.add(event.id);
        if (turn.current !== '') {
          turn.previous = turn.current;
          turn.current = '';
          turn.breakBefore = true;
        }
        return;
      case 'permission':
        this.log(live.id, `permission ${event.decision}: ${event.tool}`);
        return;
      case 'question':
        // Native questions are mapped in PR 4; the drivers decline them before this point.
        this.log(live.id, `question ignored: ${event.text}`);
        return;
      case 'error':
        this.log(live.id, `error: ${event.error.code}: ${event.error.message}`);
        return;
      case 'turn-end':
        if (turn !== null) this.endTurn(live, this.exitFor(event));
        return;
      case 'exit':
        this.onExited(live, event.exit);
        return;
    }
  }

  private exitFor(event: Extract<SessionEvent, { type: 'turn-end' }>): ProviderExit {
    if (event.stopReason === 'end_turn') return { code: 0, signal: null };
    if (event.stopReason === 'cancelled') {
      return {
        code: null,
        signal: null,
        error: { code: 'PROVIDER_ERROR', message: 'The provider cancelled the turn' },
      };
    }
    if (event.stopReason === 'error') {
      return {
        code: null,
        signal: null,
        error: event.error ?? { code: 'PROVIDER_ERROR', message: 'The provider reported an error' },
      };
    }
    return {
      code: null,
      signal: null,
      error: { code: 'PROVIDER_ERROR', message: `The provider stopped the turn: ${event.stopReason}` },
    };
  }

  private endTurn(live: Live, exit: ProviderExit): void {
    const turn = live.turn;
    if (turn === null) return;
    live.turn = null;
    live.lastUsedAt = this.deps.clock.now();
    if (!live.exited) this.setProcess(live.id, 'idle');
    turn.settle(exit);
    // The idle transition may leave more live processes than the limit allows (they were all busy before).
    if (!live.exited) this.evictFor(this.deps.configFor(live.repository).runs.maxInteractiveSessions + 1);
  }

  private onExited(live: Live, exit: ProviderExit): void {
    if (live.exited) return;
    live.exited = true;
    live.unsubscribe();
    if (live.turn !== null) {
      this.endTurn(live, {
        code: exit.code,
        signal: exit.signal,
        error: exit.error ?? { code: 'PROVIDER_ERROR', message: 'The provider process exited during the turn' },
      });
    }
    if (this.live.get(live.id) === live) this.live.delete(live.id);
    // A replacement process may already own the session; only the last one resets the row.
    if (!this.live.has(live.id)) this.setProcess(live.id, 'stopped', null);
  }

  private stopLive(live: Live): void {
    if (live.exited || live.stopping !== null) return;
    live.stopping = live.handle.stop();
    this.track(live.stopping);
  }

  private processCloseRequests(): void {
    const rows = this.deps.db
      .prepare('SELECT id FROM chat_sessions WHERE close_requested_at IS NOT NULL AND closed_at IS NULL')
      .all() as { id: number }[];
    for (const { id } of rows) {
      if (this.closing.has(id) || this.starting.has(id)) continue;
      if ((this.closeRetryAt.get(id) ?? 0) > this.deps.clock.now()) continue;
      const live = this.live.get(id);
      if (live?.turn != null) continue;
      const open = this.deps.db
        .prepare("SELECT 1 FROM runs WHERE chat_session_id = ? AND status IN ('queued', 'running')")
        .get(id);
      if (open !== undefined) continue;
      this.closing.add(id);
      this.track(
        this.finishClose(id)
          .then(() => this.closeRetryAt.delete(id))
          .catch((e: unknown) => {
            // Keep the request, say why, and wait before the next attempt instead of failing again every tick.
            const retryMs = this.deps.closeRetryMs ?? CLOSE_RETRY_MS;
            this.closeRetryAt.set(id, this.deps.clock.now() + retryMs);
            const message = `closing the chat failed (retrying in ${Math.round(retryMs / 1000)} s): ${errorMessage(e)}`;
            this.log(id, message);
            console.error(`Chat session #${id}: ${message}`);
          })
          .finally(() => this.closing.delete(id)),
      );
    }
  }

  // Stops the process, deletes the copy, and only then records the close.
  private async finishClose(id: number): Promise<void> {
    const live = this.live.get(id);
    if (live !== undefined) {
      this.stopLive(live);
      await live.stopping?.catch(() => {});
    }
    this.deps.dataDir.removeChatWorkspace(id);
    this.deps.db
      .prepare(
        `UPDATE chat_sessions SET closed_at = ?, process_state = 'stopped', pid = NULL, copy_path = NULL WHERE id = ?`,
      )
      .run(this.deps.clock.now(), id);
  }
}
