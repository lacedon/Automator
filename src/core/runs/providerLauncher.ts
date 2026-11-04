import type { Env } from '../config/load';
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
};

export interface ProviderLauncher {
  start(options: ProviderStartOptions): RunningProcess;
}

export type ProviderLaunchers = Record<ProviderName, ProviderLauncher>;
