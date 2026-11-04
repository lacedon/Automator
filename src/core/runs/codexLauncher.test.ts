import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveSecrets } from '../config/load';
import { testConfig } from '../../../test/helpers/config';
import { createCodexLauncher } from './codexLauncher';

const FAKE = path.resolve('test/fixtures/fake-codex.mjs');

function setup(opts: { bin?: string; mode?: string; denyTools?: string[] } = {}) {
  const config = testConfig({
    providers: {
      codex: { bin: opts.bin ?? FAKE, defaultModel: 'codex-model', models: ['selected-model'] },
    },
    runs: { denyTools: opts.denyTools ?? [] },
  });
  const repo = path.join(config.configDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const runDir = path.join(config.configDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const record = path.join(runDir, 'record.json');
  const transcriptPath = path.join(runDir, 'transcript.md');
  const logPath = path.join(runDir, 'codex.log');
  const resultPath = path.join(runDir, 'result.json');
  const env = {
    ...process.env,
    FAKE_CODEX_MODE: opts.mode ?? 'success',
    FAKE_CODEX_RECORD: record,
  };
  return {
    config,
    repo,
    record,
    transcriptPath,
    logPath,
    resultPath,
    env,
    launcher: createCodexLauncher(config, resolveSecrets(config, env)),
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

describe('createCodexLauncher', () => {
  test('invokes Codex with workspace-write sandbox and normalizes JSONL output and session', async () => {
    const s = setup();
    const process = s.launcher.start(options(s));

    expect(await process.exited).toEqual({ code: 0, signal: null });
    expect(await process.sessionId).toBe('codex-thread-1');
    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    expect(fs.realpathSync(recorded.cwd)).toBe(fs.realpathSync(s.repo));
    expect(recorded.argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(recorded.argv).toEqual(
      expect.arrayContaining([
        '--model',
        'selected-model',
        '--sandbox',
        'workspace-write',
        '--add-dir',
        path.dirname(s.transcriptPath),
        '--cd',
        s.repo,
      ]),
    );
    expect(recorded.argv).not.toContain('--full-auto');
    expect(recorded.argv.at(-1)).toBe(options(s).prompt);
    expect(fs.readFileSync(s.transcriptPath, 'utf8')).toContain('Codex response');
    expect(JSON.parse(fs.readFileSync(s.resultPath, 'utf8'))).toEqual({ outcome: 'acted', summary: 'codex done' });
  });

  test('resumes the provided Codex session', async () => {
    const s = setup();
    const process = s.launcher.start({ ...options(s), sessionId: 'previous-thread' });

    await process.exited;
    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as { argv: string[] };
    expect(recorded.argv).toEqual([
      'exec',
      '--json',
      '--model',
      'selected-model',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      path.dirname(s.transcriptPath),
      '--cd',
      s.repo,
      'resume',
      'previous-thread',
      options(s).prompt,
    ]);
    expect(await process.sessionId).toBe('previous-thread');
  });

  test('reports missing CLI, authentication, and model errors', async () => {
    const missing = setup({ bin: '/missing/codex' });
    expect(await missing.launcher.start(options(missing)).exited).toMatchObject({
      error: { code: 'SPAWN_FAILED' },
    });

    const auth = setup({ mode: 'auth-error' });
    expect(await auth.launcher.start(options(auth)).exited).toMatchObject({
      error: { code: 'AUTH_FAILED', message: expect.stringContaining('codex login') },
    });

    const model = setup({ mode: 'model-error' });
    expect(await model.launcher.start(options(model)).exited).toMatchObject({
      error: { code: 'MODEL_UNSUPPORTED', message: expect.stringContaining('model') },
    });

    const failed = setup({ mode: 'execution-error' });
    expect(await failed.launcher.start(options(failed)).exited).toMatchObject({
      code: 2,
      error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('Unexpected provider failure') },
    });
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
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    };
    const process = s.launcher.start({ ...options(s), env });
    await process.exited;

    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as { env: NodeJS.ProcessEnv };
    for (const name of ['GITLAB_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']) {
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

  test('reports malformed JSONL output', async () => {
    const s = setup({ mode: 'invalid-json' });
    expect(await s.launcher.start(options(s)).exited).toMatchObject({
      error: { code: 'OUTPUT_INVALID' },
    });
  });
});
