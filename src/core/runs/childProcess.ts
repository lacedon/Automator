import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Env, Secrets } from '../config/load';
import type { ProviderExit } from './providerLauncher';

const credentialName =
  /(?:^|_)(?:API_KEY|KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|TOKEN|ACCESS_KEY(?:_ID)?|SECRET(?:_ACCESS_KEY)?|PASSWORD|PRIVATE_KEY|CREDENTIALS?)(?:_FILE|_PATH)?$/i;
export const copilotAuthEnvNames = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
const copilotAuthNames = new Set<string>(copilotAuthEnvNames);

export type ChildProcessOptions = {
  cwd: string;
  env: Env;
  secrets: Secrets;
  logPath: string;
  preserveCopilotAuth?: boolean;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

export type ChildProcessHandle = {
  pid: number;
  exited: Promise<ProviderExit>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
};

export function childEnv(env: Env, secrets: Secrets, preserveCopilotAuth = false): Env {
  const out: Env = { ...env };
  for (const name of Object.keys(out)) {
    if (
      secrets.envNames.includes(name) ||
      (credentialName.test(name) && !(preserveCopilotAuth && copilotAuthNames.has(name)))
    ) {
      delete out[name];
    }
  }
  return out;
}

export function spawnChild(bin: string, args: string[], options: ChildProcessOptions): ChildProcessHandle {
  const log = fs.openSync(options.logPath, 'a');
  let child;
  try {
    child = spawn(bin, args, {
      cwd: options.cwd,
      detached: true,
      env: childEnv(options.env, options.secrets, options.preserveCopilotAuth) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fs.closeSync(log);
    throw error;
  }

  let outputError: unknown;
  const record = (chunk: Buffer, onChunk?: (buffer: Buffer) => void) => {
    try {
      fs.writeSync(log, chunk);
      onChunk?.(chunk);
    } catch (error) {
      outputError ??= error;
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => record(chunk, options.onStdout));
  child.stderr?.on('data', (chunk: Buffer) => record(chunk, options.onStderr));

  const pid = child.pid ?? 0;
  const exited = new Promise<ProviderExit>((resolve) => {
    let settled = false;
    const finish = (exit: ProviderExit) => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(log);
      } catch (error) {
        outputError ??= error;
      }
      resolve(
        outputError === undefined || exit.error !== undefined
          ? exit
          : {
              ...exit,
              error: {
                code: 'OUTPUT_FAILED',
                message: `Cannot process provider output: ${outputError instanceof Error ? outputError.message : String(outputError)}`,
              },
            },
      );
    };
    child.once('error', (error) =>
      finish({ code: null, signal: null, error: { code: 'SPAWN_FAILED', message: error.message } }),
    );
    child.once('close', (code, signal) => finish({ code, signal }));
  });

  return {
    pid,
    exited,
    kill(signal) {
      if (pid === 0) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  };
}
