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

function normalizeStream(output: string): { sessionId: string | null; transcript: string; error?: string } {
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
        error: `Invalid Claude Code stream-json output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(value)) {
      return { sessionId, transcript: text.join('\n'), error: 'Invalid Claude Code stream-json event' };
    }
    if (typeof value.session_id === 'string') sessionId = value.session_id;
    if (value.type === 'assistant' && isRecord(value.message) && Array.isArray(value.message.content)) {
      for (const part of value.message.content) {
        if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') text.push(part.text);
      }
    }
    if (value.type === 'result' && text.length === 0 && typeof value.result === 'string') text.push(value.result);
  }

  return { sessionId, transcript: text.join('\n') };
}

function providerError(exit: ProviderExit, output: string): ProviderExit {
  if (exit.error !== undefined || exit.code === 0) return exit;
  const message = output.trim();
  const lower = message.toLowerCase();
  if (
    /(authentication|unauthorized|not logged in|invalid api key|run claude auth|please.*(log ?in|auth))/.test(lower)
  ) {
    return {
      ...exit,
      error: {
        code: 'AUTH_FAILED',
        message: `Claude Code authentication failed. Run "claude auth login".${message ? ` ${message}` : ''}`,
      },
    };
  }
  if (/(unknown model|model .*(not found|unsupported|invalid|unavailable)|invalid model)/.test(lower)) {
    return {
      ...exit,
      error: {
        code: 'MODEL_UNSUPPORTED',
        message: `Claude Code rejected model "${message}". Check providers["claude-code"].models and the CLI model ID.`,
      },
    };
  }
  return {
    ...exit,
    error: {
      code: 'PROVIDER_ERROR',
      message: `Claude Code exited with code ${exit.code ?? exit.signal ?? 'unknown'}.${message ? ` ${message}` : ''}`,
    },
  };
}

export function createClaudeCodeLauncher(baseConfig: Config, baseSecrets: Secrets): ProviderLauncher {
  return {
    start(startOptions: ProviderStartOptions) {
      const config = startOptions.scope?.config ?? baseConfig;
      const secrets = startOptions.scope?.secrets ?? baseSecrets;
      const providerConfig = providerOptions(config, 'claude-code');
      if (config.runs.denyTools.length > 0) {
        return failedProcess({
          code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
          message: 'Claude Code cannot enforce runs.denyTools; clear the setting before using this provider.',
        });
      }
      if (![providerConfig.defaultModel, ...providerConfig.models].includes(startOptions.model)) {
        return failedProcess({
          code: 'MODEL_UNSUPPORTED',
          message: `Model "${startOptions.model}" is not configured for claude-code.`,
        });
      }

      const args = [
        '-p',
        startOptions.prompt,
        '--model',
        startOptions.model,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        ...(startOptions.sessionId === undefined ? [] : ['--resume', startOptions.sessionId]),
      ];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawnChild(providerConfig.bin, args, {
        cwd: startOptions.cwd,
        env: startOptions.env,
        secrets,
        logPath: startOptions.logPath,
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      });
      let normalized: ReturnType<typeof normalizeStream> = { sessionId: null, transcript: '' };
      const exited = child.exited.then((exit) => {
        const output = Buffer.concat(stdout).toString('utf8');
        normalized = normalizeStream(output);
        if (normalized.transcript !== '') writeTextAtomic(startOptions.transcriptPath, normalized.transcript);
        if (exit.error !== undefined) return exit;
        const errorOutput = `${Buffer.concat(stderr).toString('utf8')}\n${output}`;
        if (exit.code !== 0) return providerError(exit, errorOutput);
        if (normalized.error !== undefined) {
          return { ...exit, error: { code: 'OUTPUT_INVALID', message: normalized.error } };
        }
        if (normalized.sessionId === null && startOptions.sessionId === undefined) {
          return {
            ...exit,
            error: { code: 'SESSION_MISSING', message: 'Claude Code completed without reporting a session ID.' },
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
