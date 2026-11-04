import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveSecrets } from '../config/load';
import { testConfig } from '../../../test/helpers/config';
import { createClaudeCodeLauncher } from './claudeCodeLauncher';

const FAKE = path.resolve('test/fixtures/fake-claude.mjs');

function setup(opts: { bin?: string; mode?: string; denyTools?: string[] } = {}) {
  const config = testConfig({
    providers: {
      'claude-code': { bin: opts.bin ?? FAKE, defaultModel: 'claude-model', models: ['selected-model'] },
    },
    runs: { denyTools: opts.denyTools ?? [] },
  });
  const repo = path.join(config.configDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const runDir = path.join(config.configDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const record = path.join(runDir, 'record.json');
  const transcriptPath = path.join(runDir, 'transcript.md');
  const logPath = path.join(runDir, 'claude.log');
  const resultPath = path.join(runDir, 'result.json');
  const env = {
    ...process.env,
    FAKE_CLAUDE_MODE: opts.mode ?? 'success',
    FAKE_CLAUDE_RECORD: record,
  };
  return {
    config,
    repo,
    record,
    transcriptPath,
    logPath,
    resultPath,
    env,
    launcher: createClaudeCodeLauncher(config, resolveSecrets(config, env)),
  };
}

function options(s: ReturnType<typeof setup>) {
  return {
    cwd: s.repo,
    prompt: `write result to \`${s.resultPath}\``,
    model: 'selected-model',
    transcriptPath: s.transcriptPath,
    logPath: s.logPath,
    env: s.env,
  };
}

describe('createClaudeCodeLauncher', () => {
  test('invokes Claude Code non-interactively and normalizes output and session', async () => {
    const s = setup();
    const process = s.launcher.start(options(s));

    expect(await process.exited).toEqual({ code: 0, signal: null });
    expect(await process.sessionId).toBe('claude-session-1');
    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    expect(fs.realpathSync(recorded.cwd)).toBe(fs.realpathSync(s.repo));
    expect(recorded.argv).toEqual(
      expect.arrayContaining([
        '-p',
        options(s).prompt,
        '--model',
        'selected-model',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
      ]),
    );
    expect(fs.readFileSync(s.transcriptPath, 'utf8')).toContain('Assistant output');
    expect(JSON.parse(fs.readFileSync(s.resultPath, 'utf8'))).toEqual({ outcome: 'acted', summary: 'done' });
  });

  test('resumes the provided Claude Code session', async () => {
    const s = setup({ mode: 'missing-session' });
    const process = s.launcher.start({ ...options(s), sessionId: 'previous-session' });

    await process.exited;
    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as { argv: string[] };
    const index = recorded.argv.indexOf('--resume');
    expect(index).toBeGreaterThan(-1);
    expect(recorded.argv[index + 1]).toBe('previous-session');
    expect(await process.sessionId).toBe('previous-session');
  });

  test('reports missing CLI, authentication, and model errors', async () => {
    const missing = setup({ bin: '/missing/claude' });
    const missingExit = await missing.launcher.start(options(missing)).exited;
    expect(missingExit.error).toMatchObject({ code: 'SPAWN_FAILED' });

    const auth = setup({ mode: 'auth-error' });
    const authExit = await auth.launcher.start(options(auth)).exited;
    expect(authExit.error).toMatchObject({
      code: 'AUTH_FAILED',
      message: expect.stringContaining('claude auth login'),
    });

    const model = setup({ mode: 'model-error' });
    const modelExit = await model.launcher.start(options(model)).exited;
    expect(modelExit.error).toMatchObject({ code: 'MODEL_UNSUPPORTED', message: expect.stringContaining('model') });

    const failed = setup({ mode: 'execution-error' });
    expect(await failed.launcher.start(options(failed)).exited).toMatchObject({
      code: 2,
      error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('Unexpected provider failure') },
    });
  });

  test('fails a new Run when Claude Code does not report a session ID', async () => {
    const s = setup({ mode: 'missing-session' });
    const process = s.launcher.start(options(s));

    expect(await process.exited).toMatchObject({
      error: { code: 'SESSION_MISSING' },
    });
    expect(await process.sessionId).toBeNull();
  });

  test('rejects models outside the configured list without starting the CLI', async () => {
    const s = setup();
    const process = s.launcher.start({ ...options(s), model: 'not-configured' });

    expect(await process.exited).toMatchObject({
      error: { code: 'MODEL_UNSUPPORTED', message: expect.stringContaining('not-configured') },
    });
    expect(process.pid).toBe(0);
    expect(fs.existsSync(s.record)).toBe(false);
  });

  test('does not expose provider or Repository credentials to the CLI', async () => {
    const s = setup();
    const env = {
      ...s.env,
      GITLAB_TOKEN: 'gitlab-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
      OPENAI_API_KEY: 'openai-secret',
      OPENCODE_API_KEY: 'opencode-secret',
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google-credentials.json',
      AWS_ACCESS_KEY_ID: 'aws-access-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key',
      AWS_SESSION_TOKEN: 'aws-session-token',
      AZURE_CLIENT_SECRET: 'azure-secret',
    };
    const process = s.launcher.start({ ...options(s), env });
    await process.exited;

    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as { env: NodeJS.ProcessEnv };
    for (const name of [
      'GITLAB_TOKEN',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'OPENCODE_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AZURE_CLIENT_SECRET',
    ]) {
      expect(recorded.env[name]).toBeUndefined();
    }
  });

  test('fails clearly when configured tool restrictions cannot be enforced', async () => {
    const s = setup({ denyTools: ['gitlab(merge_merge_request)'] });
    const process = s.launcher.start(options(s));

    expect(process.pid).toBe(0);
    expect(await process.exited).toMatchObject({
      error: { code: 'PROVIDER_CAPABILITY_UNSUPPORTED', message: expect.stringMatching(/denyTools/i) },
    });
  });
});
