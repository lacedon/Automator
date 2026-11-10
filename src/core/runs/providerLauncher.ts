import type { Env, Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { ProviderName, RunError } from '../domain/types';

export type ProviderExit = { code: number | null; signal: string | null; error?: RunError };

export interface RunningProcess {
  pid: number;
  sessionId: Promise<string | null>;
  exited: Promise<ProviderExit>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type ProviderStartOptions = {
  cwd: string;
  prompt: string;
  model: string;
  transcriptPath: string;
  logPath: string;
  env: Env;
  sessionId?: string;
  tools?: { allowAll: boolean; allowed: string[]; blocked: string[] };
  // Effective settings of the Repository's Project; the launcher's own config is used when absent.
  scope?: { config: Config; secrets: Secrets };
};

export interface ProviderLauncher {
  start(options: ProviderStartOptions): RunningProcess;
}

export type ProviderLaunchers = Record<ProviderName, ProviderLauncher>;

export function failedProcess(error: RunError): RunningProcess {
  return {
    pid: 0,
    sessionId: Promise.resolve(null),
    exited: Promise.resolve({ code: null, signal: null, error }),
    kill() {},
  };
}
