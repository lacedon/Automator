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
  let providerFailure: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return {
        sessionId,
        transcript: text.join('\n'),
        error: `Invalid pi JSON output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(value)) {
      return { sessionId, transcript: text.join('\n'), error: 'Invalid pi JSON event' };
    }
    if (value.type === 'session' && typeof value.id === 'string') sessionId = value.id;
    if (value.type === 'message_end' && isRecord(value.message) && value.message.role === 'assistant') {
      const { content, stopReason, errorMessage } = value.message;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') text.push(part.text);
        }
      }
      if (stopReason === 'error') {
        providerFailure = typeof errorMessage === 'string' ? errorMessage : 'pi reported an unspecified error.';
      }
    }
  }

  return {
    sessionId,
    transcript: text.join('\n'),
    ...(providerFailure === undefined ? {} : { providerError: providerFailure }),
  };
}

function providerError(exit: ProviderExit, output: string): ProviderExit {
  if (exit.error !== undefined || exit.code === 0) return exit;
  const message = output.trim();
  const lower = message.toLowerCase();
  if (
    /(authentication|unauthorized|not logged in|invalid api key|pi auth login|no api key|no credentials)/.test(lower)
  ) {
    return {
      ...exit,
      error: {
        code: 'AUTH_FAILED',
        message: `pi authentication failed. Run "pi auth login <provider>".${message ? ` ${message}` : ''}`,
      },
    };
  }
  if (/(unknown model|no models match|model .*(not found|unsupported|invalid|unavailable)|invalid model)/.test(lower)) {
    return {
      ...exit,
      error: {
        code: 'MODEL_UNSUPPORTED',
        message: `pi rejected the configured model. Check providers.pi.models and the CLI model ID.${message ? ` ${message}` : ''}`,
      },
    };
  }
  return {
    ...exit,
    error: {
      code: 'PROVIDER_ERROR',
      message: `pi exited with code ${exit.code ?? exit.signal ?? 'unknown'}.${message ? ` ${message}` : ''}`,
    },
  };
}

export function createPiLauncher(baseConfig: Config, baseSecrets: Secrets): ProviderLauncher {
  return {
    start(startOptions: ProviderStartOptions) {
      const config = startOptions.scope?.config ?? baseConfig;
      const secrets = startOptions.scope?.secrets ?? baseSecrets;
      const piConfig = providerOptions(config, 'pi');
      if (![piConfig.defaultModel, ...piConfig.models].includes(startOptions.model)) {
        return failedProcess({
          code: 'MODEL_UNSUPPORTED',
          message: `Model "${startOptions.model}" is not configured for pi.`,
        });
      }

      const args = [
        '--print',
        '--mode',
        'json',
        '--model',
        startOptions.model,
        ...(startOptions.sessionId === undefined ? [] : ['--session', startOptions.sessionId]),
        ...(config.runs.denyTools.length > 0 ? ['--exclude-tools', config.runs.denyTools.join(',')] : []),
        startOptions.prompt,
      ];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawnChild(piConfig.bin, args, {
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
            error: { code: 'SESSION_MISSING', message: 'pi completed without reporting a session ID.' },
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
