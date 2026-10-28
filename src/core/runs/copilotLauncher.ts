import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Env, Secrets } from '../config/load';
import type { Config } from '../config/schema';

export type CopilotExit = { code: number | null; signal: string | null; spawnError?: string };

export interface RunningProcess {
  pid: number;
  exited: Promise<CopilotExit>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface CopilotLauncher {
  start(opts: {
    cwd: string;
    prompt: string;
    model: string;
    transcriptPath: string;
    logPath: string;
    env: Env;
    extraArgs?: string[];
    sessionId?: string;
  }): RunningProcess;
}

export function childEnv(env: Env, secrets: Secrets): Env {
  const out: Env = { ...env };
  for (const name of secrets.envNames) delete out[name];
  return out;
}

export function createCopilotLauncher(config: Config, secrets: Secrets): CopilotLauncher {
  return {
    start(opts) {
      const args = [
        '-p',
        opts.prompt,
        '--model',
        opts.model,
        '--allow-all-tools',
        // Path checks are separate from tool approval; without this Copilot cannot write copilot-result.json.
        '--add-dir',
        path.dirname(opts.transcriptPath),
        '--share',
        opts.transcriptPath,
        '--no-color',
        '--no-ask-user',
        '--log-level',
        'error',
        ...config.runs.denyTools.flatMap((pattern) => ['--deny-tool', pattern]),
        ...(secrets.envNames.length > 0 ? ['--secret-env-vars', secrets.envNames.join(',')] : []),
        ...(opts.sessionId !== undefined ? ['--session-id', opts.sessionId] : []),
        ...(opts.extraArgs ?? []),
      ];

      const log = fs.openSync(opts.logPath, 'a');
      let child;
      try {
        child = spawn(config.copilotBin, args, {
          cwd: opts.cwd,
          detached: true,
          env: childEnv(opts.env, secrets) as NodeJS.ProcessEnv,
          stdio: ['ignore', log, log],
        });
      } finally {
        fs.closeSync(log);
      }

      const exited = new Promise<CopilotExit>((resolve) => {
        child.once('error', (error) => resolve({ code: null, signal: null, spawnError: error.message }));
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const pid = child.pid ?? 0;

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
    },
  };
}
