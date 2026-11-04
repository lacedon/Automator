import path from 'node:path';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import { childEnv, spawnChild } from './childProcess';
import type { ProviderExit, ProviderLauncher, ProviderStartOptions, RunningProcess } from './providerLauncher';

export type CopilotExit = ProviderExit;
export type { RunningProcess } from './providerLauncher';

export type CopilotStartOptions = ProviderStartOptions & { extraArgs?: string[] };

export interface CopilotLauncher extends ProviderLauncher {
  start(options: CopilotStartOptions): RunningProcess;
}

export { childEnv };

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

      const child = spawnChild(config.copilotBin, args, {
        cwd: opts.cwd,
        env: opts.env,
        secrets,
        logPath: opts.logPath,
      });

      return {
        ...child,
        sessionId: Promise.resolve(opts.sessionId ?? null),
      };
    },
  };
}
