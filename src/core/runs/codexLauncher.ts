import path from 'node:path';
import { providerOptions } from '../config/providers';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { RunError } from '../domain/types';
import type { ProviderExit, ProviderLauncher, ProviderStartOptions, RunningProcess } from './providerLauncher';
import { spawnChild } from './childProcess';
import { writeTextAtomic } from '../files/atomic';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJsonl(output: string): { sessionId: string | null; transcript: string; error?: string } {
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
        error: `Invalid Codex JSONL output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(value)) {
      return { sessionId, transcript: text.join('\n'), error: 'Invalid Codex JSONL event' };
    }
    if (value.type === 'thread.started' && typeof value.thread_id === 'string') sessionId = value.thread_id;
    if (value.type === 'item.completed' && isRecord(value.item)) {
      if (value.item.type === 'agent_message' && typeof value.item.text === 'string') text.push(value.item.text);
    }
    if (value.type === 'error' && typeof value.message === 'string') {
      return { sessionId, transcript: text.join('\n'), error: value.message };
    }
  }

  return { sessionId, transcript: text.join('\n') };
}

function providerError(exit: ProviderExit, output: string): ProviderExit {
  if (exit.error !== undefined || exit.code === 0) return exit;
  const message = output.trim();
  const lower = message.toLowerCase();
  if (
    /(authentication|unauthorized|not logged in|invalid api key|codex login|openai api key|codex_api_key)/.test(lower)
  ) {
    return {
      ...exit,
      error: {
        code: 'AUTH_FAILED',
        message: `Codex authentication failed. Run "codex login".${message ? ` ${message}` : ''}`,
      },
    };
  }
  if (/(unknown model|model .*(not found|unsupported|invalid|unavailable)|invalid model)/.test(lower)) {
    return {
      ...exit,
      error: {
        code: 'MODEL_UNSUPPORTED',
        message: `Codex rejected the configured model. Check providers.codex.models and the CLI model ID.${message ? ` ${message}` : ''}`,
      },
    };
  }
  return {
    ...exit,
    error: {
      code: 'PROVIDER_ERROR',
      message: `Codex exited with code ${exit.code ?? exit.signal ?? 'unknown'}.${message ? ` ${message}` : ''}`,
    },
  };
}

function failedProcess(error: RunError): RunningProcess {
  return {
    pid: 0,
    sessionId: Promise.resolve(null),
    exited: Promise.resolve({ code: null, signal: null, error }),
    kill() {},
  };
}

export function createCodexLauncher(config: Config, secrets: Secrets): ProviderLauncher {
  const codexConfig = providerOptions(config, 'codex');

  return {
    start(startOptions: ProviderStartOptions) {
      if (config.runs.denyTools.length > 0) {
        return failedProcess({
          code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
          message: 'Codex cannot enforce runs.denyTools; clear the setting before using this provider.',
        });
      }
      if (![codexConfig.defaultModel, ...codexConfig.models].includes(startOptions.model)) {
        return failedProcess({
          code: 'MODEL_UNSUPPORTED',
          message: `Model "${startOptions.model}" is not configured for codex.`,
        });
      }

      // Codex needs a narrow grant to write Automator's Run files outside the Repository.
      const runArtifactsDir = path.dirname(startOptions.transcriptPath);
      const args = [
        'exec',
        ...(startOptions.sessionId === undefined ? [] : ['resume', startOptions.sessionId]),
        '--json',
        '--model',
        startOptions.model,
        '--sandbox',
        'workspace-write',
        '--add-dir',
        runArtifactsDir,
        '--cd',
        startOptions.cwd,
        startOptions.prompt,
      ];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawnChild(codexConfig.bin, args, {
        cwd: startOptions.cwd,
        env: startOptions.env,
        secrets,
        logPath: startOptions.logPath,
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      });
      let normalized: ReturnType<typeof normalizeJsonl> = { sessionId: null, transcript: '' };
      const exited = child.exited.then((exit) => {
        const output = Buffer.concat(stdout).toString('utf8');
        normalized = normalizeJsonl(output);
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
            error: { code: 'SESSION_MISSING', message: 'Codex completed without reporting a thread ID.' },
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
