import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveSecrets } from '../config/load';
import { testConfig } from '../../../test/helpers/config';
import { createOpenCodeLauncher } from './opencodeLauncher';

const FAKE = path.resolve('test/fixtures/fake-opencode.mjs');
const MODEL = 'selected-provider/selected-model';

function setup(opts: { bin?: string; mode?: string; denyTools?: string[] } = {}) {
  const config = testConfig({
    providers: {
      opencode: { bin: opts.bin ?? FAKE, defaultModel: MODEL, models: [MODEL] },
    },
    runs: { denyTools: opts.denyTools ?? [] },
  });
  const repo = path.join(config.configDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const runDir = path.join(config.configDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const record = path.join(runDir, 'record.json');
  const transcriptPath = path.join(runDir, 'transcript.md');
  const logPath = path.join(runDir, 'opencode.log');
  const resultPath = path.join(runDir, 'result.json');
  const env = {
    ...process.env,
    FAKE_OPENCODE_MODE: opts.mode ?? 'success',
    FAKE_OPENCODE_RECORD: record,
  };
  return {
    config,
    repo,
    record,
    transcriptPath,
    logPath,
    resultPath,
    env,
    launcher: createOpenCodeLauncher(config, resolveSecrets(config, env)),
  };
}

function options(s: ReturnType<typeof setup>) {
  return {
    cwd: s.repo,
    prompt: `write result to \`${s.resultPath}\``,
    model: MODEL,
    transcriptPath: s.transcriptPath,
    logPath: s.logPath,
    env: s.env,
  };
}

describe('createOpenCodeLauncher', () => {
  test('runs non-interactively and normalizes JSON events and session', async () => {
    const s = setup();
    const process = s.launcher.start(options(s));

    expect(await process.exited).toEqual({ code: 0, signal: null });
    expect(await process.sessionId).toBe('opencode-session-1');
    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    expect(fs.realpathSync(recorded.cwd)).toBe(fs.realpathSync(s.repo));
    expect(recorded.env.PWD).toBe(s.repo);
    expect(recorded.argv.slice(0, 2)).toEqual(['--auto', 'run']);
    expect(recorded.argv).toEqual(expect.arrayContaining(['--format', 'json', '--model', MODEL]));
    expect(recorded.argv.at(-1)).toBe(options(s).prompt);
    expect(fs.readFileSync(s.transcriptPath, 'utf8')).toContain('OpenCode response');
    expect(JSON.parse(fs.readFileSync(s.resultPath, 'utf8'))).toEqual({
      outcome: 'acted',
      summary: 'opencode done',
    });
  });

  test('resumes the provided OpenCode session', async () => {
    const s = setup();
    const process = s.launcher.start({ ...options(s), sessionId: 'previous-session' });

    await process.exited;
    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as { argv: string[] };
    const index = recorded.argv.indexOf('--session');
    expect(recorded.argv[index + 1]).toBe('previous-session');
    expect(await process.sessionId).toBe('previous-session');
  });

  test('reports missing CLI, authentication, and model errors', async () => {
    const missing = setup({ bin: '/missing/opencode' });
    expect(await missing.launcher.start(options(missing)).exited).toMatchObject({
      error: { code: 'SPAWN_FAILED' },
    });

    const auth = setup({ mode: 'auth-error' });
    expect(await auth.launcher.start(options(auth)).exited).toMatchObject({
      error: { code: 'AUTH_FAILED', message: expect.stringContaining('opencode auth login') },
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
      OPENCODE_API_KEY: 'opencode-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    };
    const process = s.launcher.start({ ...options(s), env });
    await process.exited;

    const recorded = JSON.parse(fs.readFileSync(s.record, 'utf8')) as { env: NodeJS.ProcessEnv };
    for (const name of ['GITLAB_TOKEN', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY']) {
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

  test('reports malformed JSON output', async () => {
    const s = setup({ mode: 'invalid-json' });
    expect(await s.launcher.start(options(s)).exited).toMatchObject({
      error: { code: 'OUTPUT_INVALID' },
    });
  });
});
