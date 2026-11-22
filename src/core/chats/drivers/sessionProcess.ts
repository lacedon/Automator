import fs from 'node:fs';
import type { Env, Secrets } from '../../config/load';
import type { ProviderExit } from '../../runs/providerLauncher';
import { spawnChild, type ChildProcessHandle } from '../../runs/childProcess';
import type { SessionEvent, StopTimings } from './sessionDriver';
import { DEFAULT_STOP_TIMINGS } from './sessionDriver';

const MAX_LOG_LINE = 4_000;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const AUTH_STATUS_METHOD = /"method"\s*:\s*"(_?auth\/status_update)"/;

// Protocol lines go to the per-session log. The adapters report the signed-in account in auth status
// notifications, so those payloads (and any email address) never reach the log.
export function redactProtocolLine(line: string): string {
  const prefix = /^[<>] /.test(line) ? line.slice(0, 2) : '';
  const body = prefix === '' ? line : line.slice(2);
  const auth = AUTH_STATUS_METHOD.exec(body);
  const text = auth === null ? body : JSON.stringify({ method: auth[1], params: '(redacted)' });
  const redacted = text.replace(EMAIL, '<redacted-email>');
  return `${prefix}${redacted.length > MAX_LOG_LINE ? `${redacted.slice(0, MAX_LOG_LINE)}… (truncated)` : redacted}`;
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
  onStderr?: (chunk: Buffer) => void;
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
  const log = (line: string): void => {
    try {
      fs.appendFileSync(options.logPath, `${new Date().toISOString()} ${redactProtocolLine(line)}\n`);
    } catch {
      // The log is best effort.
    }
  };
  const child = spawnChild(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env,
    secrets: options.secrets,
    logPath: options.logPath,
    preserveCopilotAuth: options.preserveCopilotAuth,
    stdin: 'pipe',
    logStdout: false,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
  let exitedFlag = false;
  const exited = child.exited.then((exit) => {
    exitedFlag = true;
    return exit;
  });

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
      child.kill('SIGTERM');
      if ((await waitOrTimeout(timings.killGraceMs)) !== null) return exited;
      child.kill('SIGKILL');
      return exited;
    },
    kill() {
      if (!exitedFlag) child.kill('SIGKILL');
    },
  };
}
