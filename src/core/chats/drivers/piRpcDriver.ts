import { randomUUID } from 'node:crypto';
import type { Env, Secrets } from '../../config/load';
import { providerOptions } from '../../config/providers';
import type { Config } from '../../config/schema';
import type { RunError } from '../../domain/types';
import type { ProviderExit } from '../../runs/providerLauncher';
import { lineSplitter } from '../../runs/liveTranscript';
import { MAX_LINE_CHARS } from './jsonRpc';
import {
  DriverError,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type SessionStartOptions,
  HANDSHAKE_REQUEST_TIMEOUT_MS,
  type DriverTimings,
  type TurnStopReason,
} from './sessionDriver';
import { spawnSessionProcess } from './sessionProcess';
import { piToolArgs } from './toolPolicy';

export type PiDriverTimings = DriverTimings & { abortDeadlineMs?: number };
const DEFAULT_ABORT_DEADLINE_MS = 10_000;
const STDERR_TAIL = 2_000;

// Fire-and-forget extension UI methods need no answer; dialogs block pi until the client replies.
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function createPiRpcDriver(
  baseConfig: Config,
  baseSecrets: Secrets,
  timings: PiDriverTimings = {},
): SessionDriver {
  return {
    provider: 'pi',
    start(options: SessionStartOptions): SessionHandle {
      const config = options.scope?.config ?? baseConfig;
      const secrets = options.scope?.secrets ?? baseSecrets;
      return new PiSession(providerOptions(config, 'pi').bin, secrets, options, timings);
    },
  };
}

class PiSession implements SessionHandle {
  readonly pid: number;
  readonly ready: Promise<{ providerSessionId: string }>;
  readonly exited: Promise<ProviderExit>;

  private readonly proc;
  private readonly bin: string;
  private readonly providerSessionId: string;
  private readonly resuming: boolean;
  private stderrTail = ''; // the last STDERR_TAIL characters of (redacted) stderr, never more
  private readonly responses = new Map<string, { resolve(value: Rec): void; reject(error: Error): void }>();
  private nextId = 1;
  private promptInFlight = false;
  private turnFinished = true;
  private abortRequested = false;
  private abortTimer: NodeJS.Timeout | null = null;
  private providerFailure: string | null = null;
  private fatal: RunError | null = null;
  private readonly abortDeadlineMs: number;
  private readonly requestTimeoutMs: number;

  constructor(bin: string, secrets: Secrets, options: SessionStartOptions, timings: PiDriverTimings) {
    this.bin = bin;
    this.abortDeadlineMs = timings.abortDeadlineMs ?? DEFAULT_ABORT_DEADLINE_MS;
    this.requestTimeoutMs = timings.requestTimeoutMs ?? HANDSHAKE_REQUEST_TIMEOUT_MS;
    this.resuming = options.providerSessionId !== undefined;
    // The id of a new session is generated here and stored by the caller as provider_session_id.
    this.providerSessionId = options.providerSessionId ?? randomUUID();
    const args = [
      '--mode',
      'rpc',
      // The user's own extensions would emit UI requests and change behaviour; ours is added with -e in PR 4.
      '--no-extensions',
      '--model',
      options.model,
      ...(options.sessionDir === undefined ? [] : ['--session-dir', options.sessionDir]),
      ...(this.resuming ? ['--session', this.providerSessionId] : ['--session-id', this.providerSessionId]),
      ...piToolArgs(options.tools),
    ];
    const splitter = lineSplitter((line) => this.onLine(line), {
      maxLineChars: MAX_LINE_CHARS,
      onOversize: (chars) => this.proc.log(`oversized line (${chars} chars) dropped`),
    });
    this.proc = spawnSessionProcess({
      bin,
      args,
      cwd: options.cwd,
      env: { ...options.env, PWD: options.cwd } as Env,
      secrets,
      logPath: options.logPath,
      onStdout: (chunk) => splitter.push(chunk),
      onStderrLine: (line) => {
        this.stderrTail = `${this.stderrTail}${line}\n`.slice(-STDERR_TAIL);
      },
      timings,
    });
    this.pid = this.proc.child.pid;
    this.exited = this.proc.exited.then((exit) => {
      splitter.end();
      this.onExit(exit);
      return exit;
    });
    this.ready = this.handshake();
    this.ready.catch(() => {});
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    return this.proc.onEvent(listener);
  }

  private write(command: Rec): void {
    const line = JSON.stringify(command);
    this.proc.log(`> ${line}`);
    try {
      this.proc.child.stdin?.write(`${line}\n`);
    } catch {
      // The exit handler reports the failure.
    }
  }

  private request(command: Rec, timeoutMs?: number): Promise<Rec> {
    if (this.proc.hasExited()) return Promise.reject(new Error('The provider process has exited'));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              if (this.responses.delete(id)) {
                this.proc.kill();
                reject(new DriverError({ code: 'PROVIDER_ERROR', message: `pi did not answer ${str(command.type)}.` }));
              }
            }, timeoutMs);
      this.responses.set(id, {
        resolve: (value) => {
          if (timer !== null) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer !== null) clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, ...command });
    });
  }

  private async handshake(): Promise<{ providerSessionId: string }> {
    try {
      const state = await this.request({ type: 'get_state' }, this.requestTimeoutMs);
      if (state.success !== true) {
        throw new DriverError({
          code: 'PROVIDER_ERROR',
          message: `pi get_state failed: ${str(state.error) ?? 'unknown error'}`,
        });
      }
      const data = isRecord(state.data) ? state.data : {};
      const id = str(data.sessionId) ?? this.providerSessionId;
      this.proc.emit({ type: 'session', providerSessionId: id });
      return { providerSessionId: id };
    } catch (error) {
      if (error instanceof DriverError) throw error;
      const exit = await this.proc.exited;
      throw new DriverError(this.exitError(exit));
    }
  }

  private exitError(exit: ProviderExit): RunError {
    if (exit.error !== undefined) {
      if (exit.error.code === 'SPAWN_FAILED') {
        return { code: 'SPAWN_FAILED', message: `Cannot start "${this.bin}": ${exit.error.message}.` };
      }
      return exit.error;
    }
    const tail = this.stderrTail.trim();
    if (this.resuming && /No session found/i.test(tail)) {
      return {
        code: 'SESSION_RESUME_FAILED',
        message: `pi could not resume session ${this.providerSessionId}: ${tail}`,
      };
    }
    const lower = tail.toLowerCase();
    if (
      /(authentication|unauthorized|not logged in|invalid api key|pi auth login|no api key|no credentials)/.test(lower)
    ) {
      return {
        code: 'AUTH_FAILED',
        message: `pi authentication failed. Run "pi auth login <provider>". ${tail}`.trim(),
      };
    }
    const how = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${exit.code}`;
    return { code: 'PROVIDER_ERROR', message: `pi exited with ${how}.${tail === '' ? '' : ` ${tail}`}` };
  }

  private onExit(exit: ProviderExit): void {
    const error = this.exitError(exit);
    this.fatal = error;
    this.clearAbortTimer();
    for (const waiter of this.responses.values()) waiter.reject(new Error(error.message));
    this.responses.clear();
    if (this.promptInFlight) {
      this.finishTurn(this.abortRequested ? { stopReason: 'cancelled' } : { stopReason: 'error', error });
    }
    this.proc.emit({ type: 'exit', exit: exit.error === undefined ? exit : { ...exit, error } });
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.proc.log('malformed JSON line ignored');
      return;
    }
    if (!isRecord(value)) return;
    // The system message carries the whole system prompt on every turn; it is neither logged nor emitted.
    const isSystem = isRecord(value.message) && value.message.role === 'system';
    this.proc.log(
      isSystem ? `< {"type":"${str(value.type) ?? ''}","message":"(system message omitted)"}` : `< ${line}`,
    );
    this.handle(value, isSystem);
  }

  private handle(record: Rec, isSystem: boolean): void {
    const type = str(record.type);
    if (type === 'response') {
      const id = str(record.id);
      const waiter = id === undefined ? undefined : this.responses.get(id);
      if (id !== undefined && waiter !== undefined) {
        this.responses.delete(id);
        waiter.resolve(record);
      }
      return;
    }
    if (isSystem) return;
    switch (type) {
      case 'extension_ui_request':
        this.onUiRequest(record);
        return;
      case 'message_update': {
        const event = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : {};
        const delta = str(event.delta);
        if (event.type === 'text_delta' && delta !== undefined && delta !== '') this.proc.emit({ type: 'text', delta });
        return;
      }
      case 'message_end': {
        const message = isRecord(record.message) ? record.message : {};
        if (message.role === 'assistant' && message.stopReason === 'error') {
          this.providerFailure = str(message.errorMessage) ?? 'pi reported an unspecified error.';
        }
        return;
      }
      case 'tool_execution_start': {
        const id = str(record.toolCallId);
        if (id !== undefined)
          this.proc.emit({ type: 'tool-call', id, title: str(record.toolName) ?? 'tool', status: 'in_progress' });
        return;
      }
      case 'tool_execution_end': {
        const id = str(record.toolCallId);
        if (id !== undefined) {
          this.proc.emit({
            type: 'tool-call',
            id,
            title: str(record.toolName) ?? 'tool',
            status: record.isError === true ? 'failed' : 'completed',
          });
        }
        return;
      }
      case 'agent_settled':
        this.onSettled(record.aborted === true);
        return;
      default:
    }
  }

  // Extension dialogs are declined until PR 4 maps them to questions; everything else is fire-and-forget.
  private onUiRequest(record: Rec): void {
    const method = str(record.method);
    const id = str(record.id);
    if (method === undefined || id === undefined || !DIALOG_METHODS.has(method)) return;
    this.proc.log(`declined extension dialog (${method}): ${str(record.title) ?? ''}`);
    this.write({ type: 'extension_ui_response', id, cancelled: true });
  }

  private onSettled(aborted: boolean): void {
    if (!this.promptInFlight) return;
    const failure = this.providerFailure;
    if (aborted || this.abortRequested) this.finishTurn({ stopReason: 'cancelled' });
    else if (failure !== null)
      this.finishTurn({ stopReason: 'error', error: { code: 'PROVIDER_ERROR', message: failure } });
    else this.finishTurn({ stopReason: 'end_turn' });
  }

  send(message: string): Promise<void> {
    if (this.fatal !== null || this.proc.hasExited())
      return Promise.reject(new Error('The provider process has exited'));
    if (this.promptInFlight) return Promise.reject(new Error('A turn is in flight'));
    this.promptInFlight = true;
    this.turnFinished = false;
    this.abortRequested = false;
    this.providerFailure = null;
    this.proc.emit({ type: 'turn-start', prompted: true });
    this.request({ type: 'prompt', message }).then(
      (response) => {
        if (response.success !== true) {
          this.finishTurn({
            stopReason: 'error',
            error: {
              code: 'PROVIDER_ERROR',
              message: `pi rejected the prompt: ${str(response.error) ?? 'unknown error'}`,
            },
          });
          return;
        }
        const data = isRecord(response.data) ? response.data : {};
        // Anything but "started" means no run began, so no agent_settled will follow.
        if (data.disposition !== 'started') this.finishTurn({ stopReason: 'end_turn' });
      },
      () => {
        // The exit handler reports a crash.
      },
    );
    return Promise.resolve();
  }

  private finishTurn(end: { stopReason: TurnStopReason; error?: RunError }): void {
    if (this.turnFinished) return;
    this.turnFinished = true;
    this.promptInFlight = false;
    this.clearAbortTimer();
    this.proc.emit({ type: 'turn-end', ...end });
  }

  private clearAbortTimer(): void {
    if (this.abortTimer !== null) clearTimeout(this.abortTimer);
    this.abortTimer = null;
  }

  respond(): void {
    // Extension dialogs are declined inside the driver until PR 4.
  }

  cancelTurn(): void {
    if (!this.promptInFlight || this.abortRequested) return;
    this.abortRequested = true;
    this.write({ type: 'abort' });
    // A tool that ignores its abort signal can hold the settle back; stop the process after the deadline.
    this.abortTimer = setTimeout(() => {
      this.abortTimer = null;
      if (this.promptInFlight) void this.stop();
    }, this.abortDeadlineMs);
  }

  stop(): Promise<ProviderExit> {
    return this.proc.stop();
  }

  kill(): void {
    this.proc.kill();
  }
}
