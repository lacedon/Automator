import fs from 'node:fs';
import type { Env, Secrets } from '../../config/load';
import type { ProviderExit } from '../../runs/providerLauncher';
import { lineSplitter } from '../../runs/liveTranscript';
import { spawnChild, type ChildProcessHandle } from '../../runs/childProcess';
import type { SessionEvent, StopTimings } from './sessionDriver';
import { DEFAULT_STOP_TIMINGS } from './sessionDriver';

const MAX_LOG_LINE = 4_000;
// A session log stops growing here (the rest of a long Chat is not worth the disk).
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
// Bounded segments keep the pattern linear on adversarial input; real addresses fit well inside them.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
const AUTH_STATUS_METHOD = /"method"\s*:\s*"(_?auth\/status_update)"/;

// Protocol lines and provider stderr go to the per-session log. The adapters report the signed-in account in auth
// status notifications, so those payloads (and any email address) never reach the log. The line is cut first, so
// the cost does not depend on how long the provider's line is.
export function redactProtocolLine(line: string): string {
  const cut = line.length > MAX_LOG_LINE + 2;
  const head = cut ? line.slice(0, MAX_LOG_LINE + 2) : line;
  const prefix = /^[<>!] /.test(head) ? head.slice(0, 2) : '';
  const body = head.slice(prefix.length);
  const auth = AUTH_STATUS_METHOD.exec(body);
  const text = auth === null ? body : JSON.stringify({ method: auth[1], params: '(redacted)' });
  const redacted = text.replace(EMAIL, '<redacted-email>');
  return `${prefix}${redacted.length > MAX_LOG_LINE ? redacted.slice(0, MAX_LOG_LINE) : redacted}${cut || redacted.length > MAX_LOG_LINE ? '… (truncated)' : ''}`;
}

// Appends redacted lines to the session log until MAX_LOG_BYTES, then writes one marker and drops the rest.
export function createSessionLog(logPath: string, maxBytes = MAX_LOG_BYTES): (line: string) => void {
  let written = 0;
  try {
    written = fs.statSync(logPath).size;
  } catch {
    // A new file.
  }
  let capped = false;
  return (line) => {
    if (capped) return;
    try {
      let text = `${new Date().toISOString()} ${redactProtocolLine(line)}\n`;
      if (written + Buffer.byteLength(text) > maxBytes) {
        capped = true;
        text = `${new Date().toISOString()} log limit of ${maxBytes} bytes reached; further output is not recorded\n`;
      }
      fs.appendFileSync(logPath, text);
      written += Buffer.byteLength(text);
    } catch {
      // The log is best effort.
    }
  };
}

export type SessionProcessOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: Env;
  secrets: Secrets;
  logPath: string;
  preserveCopilotAuth?: boolean;
  onStdout: (chunk: Buffer) => void;
  // Complete stderr lines, already redacted and cut: safe to keep and to show to the user.
  onStderrLine?: (line: string) => void;
  timings?: Partial<StopTimings>;
};

export type SessionProcess = {
  child: ChildProcessHandle;
  exited: Promise<ProviderExit>;
  log(line: string): void;
  emit(event: SessionEvent): void;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  hasExited(): boolean;
  stop(): Promise<ProviderExit>;
  kill(): void;
};

// Spawns a long-lived provider process in its own process group with a piped stdin. The environment is filtered
// by childEnv inside spawnChild, so no credential variable reaches the provider or its tools.
export function spawnSessionProcess(options: SessionProcessOptions): SessionProcess {
  const timings = { ...DEFAULT_STOP_TIMINGS, ...options.timings };
  const listeners = new Set<(event: SessionEvent) => void>();
  const log = createSessionLog(options.logPath);
  const stderr = lineSplitter((line) => {
    if (line.trim() === '') return;
    const redacted = redactProtocolLine(`! ${line}`);
    log(`! ${line}`);
    options.onStderrLine?.(redacted.slice(2));
  });
  const child = spawnChild(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env,
    secrets: options.secrets,
    logPath: options.logPath,
    preserveCopilotAuth: options.preserveCopilotAuth,
    stdin: 'pipe',
    logStdout: false,
    logStderr: false,
    onStdout: options.onStdout,
    onStderr: (chunk) => stderr.push(chunk),
  });
  log(`spawned ${options.bin} (pid ${child.pid})`);
  let exitedFlag = false;
  const exited = child.exited.then((exit) => {
    exitedFlag = true;
    stderr.end();
    return exit;
  });

  // A group that is already dying (a zombie) answers EPERM on some systems; there is nothing left to signal.
  const signalGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  const waitOrTimeout = (ms: number): Promise<ProviderExit | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      void exited.then((exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });

  return {
    child,
    exited,
    log,
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          log(`event listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasExited: () => exitedFlag,
    async stop() {
      if (exitedFlag) return exited;
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      if ((await waitOrTimeout(timings.stdinGraceMs)) !== null) return exited;
      signalGroup('SIGTERM');
      if ((await waitOrTimeout(timings.killGraceMs)) !== null) return exited;
      signalGroup('SIGKILL');
      return exited;
    },
    kill() {
      if (!exitedFlag) signalGroup('SIGKILL');
    },
  };
}
