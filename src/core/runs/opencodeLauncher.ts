import { providerOptions } from '../config/providers';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { ProviderExit, ProviderLauncher, ProviderStartOptions } from './providerLauncher';
import { spawnChild } from './childProcess';
import { writeTextAtomic } from '../files/atomic';
import { failedProcess } from './providerLauncher';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJson(output: string): {
  sessionId: string | null;
  transcript: string;
  error?: string;
  providerError?: string;
} {
  let sessionId: string | null = null;
  const text: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return {
        sessionId,
        transcript: text.join('\n'),
        error: `Invalid OpenCode JSON output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(value)) {
      return { sessionId, transcript: text.join('\n'), error: 'Invalid OpenCode JSON event' };
    }
    if (typeof value.sessionID === 'string') sessionId = value.sessionID;
    if (value.type === 'text' && isRecord(value.part) && value.part.type === 'text') {
      if (typeof value.part.text === 'string') text.push(value.part.text);
    }
    if (value.type === 'error') {
      const error = isRecord(value.error) ? value.error.message : value.error;
      return {
        sessionId,
        transcript: text.join('\n'),
        providerError: typeof error === 'string' ? error : 'OpenCode reported an unspecified error.',
      };
    }
  }

  return { sessionId, transcript: text.join('\n') };
}

function providerError(exit: ProviderExit, output: string): ProviderExit {
  if (exit.error !== undefined || exit.code === 0) return exit;
  const message = output.trim();
  const lower = message.toLowerCase();
  if (/(authentication|unauthorized|not logged in|invalid api key|opencode auth login|no auth)/.test(lower)) {
    return {
      ...exit,
      error: {
        code: 'AUTH_FAILED',
        message: `OpenCode authentication failed. Run "opencode auth login".${message ? ` ${message}` : ''}`,
      },
    };
  }
  if (/(unknown model|model .*(not found|unsupported|invalid|unavailable)|invalid model)/.test(lower)) {
    return {
      ...exit,
      error: {
        code: 'MODEL_UNSUPPORTED',
        message: `OpenCode rejected the configured model. Check providers.opencode.models and the CLI model ID.${message ? ` ${message}` : ''}`,
      },
    };
  }
  return {
    ...exit,
    error: {
      code: 'PROVIDER_ERROR',
      message: `OpenCode exited with code ${exit.code ?? exit.signal ?? 'unknown'}.${message ? ` ${message}` : ''}`,
    },
  };
}

export function createOpenCodeLauncher(baseConfig: Config, baseSecrets: Secrets): ProviderLauncher {
  return {
    start(startOptions: ProviderStartOptions) {
      const config = startOptions.scope?.config ?? baseConfig;
      const secrets = startOptions.scope?.secrets ?? baseSecrets;
      const opencodeConfig = providerOptions(config, 'opencode');
      if (config.runs.denyTools.length > 0) {
        return failedProcess({
          code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
          message: 'OpenCode cannot enforce runs.denyTools; clear the setting before using this provider.',
        });
      }
      if (![opencodeConfig.defaultModel, ...opencodeConfig.models].includes(startOptions.model)) {
        return failedProcess({
          code: 'MODEL_UNSUPPORTED',
          message: `Model "${startOptions.model}" is not configured for opencode.`,
        });
      }

      const args = [
        '--auto',
        'run',
        ...(startOptions.sessionId === undefined ? [] : ['--session', startOptions.sessionId]),
        '--format',
        'json',
        '--model',
        startOptions.model,
        startOptions.prompt,
      ];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawnChild(opencodeConfig.bin, args, {
        cwd: startOptions.cwd,
        env: { ...startOptions.env, PWD: startOptions.cwd },
        secrets,
        logPath: startOptions.logPath,
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      });
      let normalized: ReturnType<typeof normalizeJson> = { sessionId: null, transcript: '' };
      const exited = child.exited.then((exit) => {
        const output = Buffer.concat(stdout).toString('utf8');
        normalized = normalizeJson(output);
        if (normalized.transcript !== '') writeTextAtomic(startOptions.transcriptPath, normalized.transcript);
        if (exit.error !== undefined) return exit;
        if (normalized.error !== undefined) {
          return { ...exit, error: { code: 'OUTPUT_INVALID', message: normalized.error } };
        }
        const errorOutput = normalized.providerError ?? `${Buffer.concat(stderr).toString('utf8')}\n${output}`;
        if (normalized.providerError !== undefined) {
          return providerError({ ...exit, code: exit.code === 0 ? 1 : exit.code }, errorOutput);
        }
        if (exit.code !== 0) return providerError(exit, errorOutput);
        if (normalized.sessionId === null && startOptions.sessionId === undefined) {
          return {
            ...exit,
            error: { code: 'SESSION_MISSING', message: 'OpenCode completed without reporting a session ID.' },
          };
        }
        return exit;
      });

      return {
        pid: child.pid,
        sessionId: exited.then(() => normalized.sessionId ?? startOptions.sessionId ?? null),
        exited,
        kill: child.kill,
      };
    },
  };
}
