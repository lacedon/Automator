import path from 'node:path';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import { childEnv, copilotAuthEnvNames, spawnChild } from './childProcess';
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
      const secretEnvNames = new Set(secrets.envNames);
      for (const name of copilotAuthEnvNames) {
        if (opts.env[name] !== undefined) secretEnvNames.add(name);
      }
      const args = [
        '-p',
        opts.prompt,
        '--model',
        opts.model,
        ...(opts.tools?.allowAll === false ? [] : ['--allow-all-tools']),
        // Path checks are separate from tool approval; without this Copilot cannot write copilot-result.json.
        '--add-dir',
        path.dirname(opts.transcriptPath),
        '--share',
        opts.transcriptPath,
        '--no-color',
        '--no-ask-user',
        '--log-level',
        'error',
        // Without allow-all, --no-ask-user denies unapproved tools, so the result file write must be allowed explicitly.
        ...(opts.tools?.allowAll === false ? ['--allow-tool', 'write'] : []),
        ...(opts.tools?.allowed ?? []).flatMap((pattern) => ['--allow-tool', pattern]),
        ...[...config.runs.denyTools, ...(opts.tools?.blocked ?? [])].flatMap((pattern) => ['--deny-tool', pattern]),
        ...(secretEnvNames.size > 0 ? ['--secret-env-vars', [...secretEnvNames].join(',')] : []),
        ...(opts.sessionId !== undefined ? ['--session-id', opts.sessionId] : []),
        ...(opts.extraArgs ?? []),
      ];

      const child = spawnChild(config.copilotBin, args, {
        cwd: opts.cwd,
        env: opts.env,
        secrets,
        logPath: opts.logPath,
        preserveCopilotAuth: true,
      });

      return {
        ...child,
        sessionId: Promise.resolve(opts.sessionId ?? null),
      };
    },
  };
}
