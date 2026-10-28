import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import type { Config } from '../config/schema';
import { resolveSecrets } from '../config/load';
import { childEnv, createCopilotLauncher } from './copilotLauncher';

const FAKE = path.resolve('test/fixtures/fake-copilot.mjs');

type Recorded = { argv: string[]; cwd: string; env: NodeJS.ProcessEnv };

function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  const config: Config = testConfig({ copilotBin: FAKE, ...overrides });
  const root = config.configDir;
  const repo = path.join(root, 'repo with space');
  fs.mkdirSync(repo, { recursive: true });
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  return {
    config,
    repo,
    record: path.join(runDir, 'record.json'),
    childPidFile: path.join(runDir, 'child.pid'),
    transcriptPath: path.join(runDir, 'transcript.md'),
    logPath: path.join(runDir, 'copilot.log'),
    resultPath: path.join(runDir, 'copilot-result.json'),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe('createCopilotLauncher', () => {
  test('passes required args and deny tools', async () => {
    const s = setup({ runs: { denyTools: ['gitlab(merge_merge_request)'] } });
    const launcher = createCopilotLauncher(s.config, resolveSecrets(s.config, {}));
    const proc = launcher.start({
      cwd: s.repo,
      prompt: `Do it.\nwrite exactly this JSON to \`${s.resultPath}\``,
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...process.env, FAKE_COPILOT_MODE: 'nothing', FAKE_COPILOT_RECORD: s.record },
    });
    expect(proc.pid).toBeGreaterThan(0);
    expect(await proc.exited).toEqual({ code: 0, signal: null });

    const rec = JSON.parse(fs.readFileSync(s.record, 'utf8')) as Recorded;
    expect(fs.realpathSync(rec.cwd)).toBe(fs.realpathSync(s.repo));
    const args = rec.argv;
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--allow-all-tools');
    expect(after('--share')).toBe(s.transcriptPath);
    expect(after('--model')).toBe('m1');
    expect(after('--deny-tool')).toBe('gitlab(merge_merge_request)');
    expect(after('--log-level')).toBe('error');
    expect(after('--add-dir')).toBe(path.dirname(s.transcriptPath));
    expect(args).toEqual(expect.arrayContaining(['--no-color', '--no-ask-user']));
    expect(after('-p')).toContain('write exactly this JSON to');
    expect(fs.readFileSync(s.transcriptPath, 'utf8')).toBe('# fake transcript\nnothing\n');
    expect(JSON.parse(fs.readFileSync(s.resultPath, 'utf8'))).toEqual({ outcome: 'nothing', summary: 'fake nothing' });
  });

  test('strips secret env vars', async () => {
    const s = setup({
      jira: { connections: { corp: { emailEnv: 'JIRA_EMAIL', tokenEnv: 'JIRA_TOKEN' } } },
    });
    const env = { ...process.env, GITLAB_TOKEN: 'g', JIRA_EMAIL: 'e', JIRA_TOKEN: 't', KEEP_ME: 'yes' };
    const secrets = resolveSecrets(s.config, env);
    const launcher = createCopilotLauncher(s.config, secrets);
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...env, FAKE_COPILOT_MODE: 'no-result', FAKE_COPILOT_RECORD: s.record },
    });
    await proc.exited;

    const rec = JSON.parse(fs.readFileSync(s.record, 'utf8')) as Recorded;
    expect(rec.env.GITLAB_TOKEN).toBeUndefined();
    expect(rec.env.JIRA_EMAIL).toBeUndefined();
    expect(rec.env.JIRA_TOKEN).toBeUndefined();
    expect(rec.env.KEEP_ME).toBe('yes');
    const i = rec.argv.indexOf('--secret-env-vars');
    expect(rec.argv[i + 1]?.split(',').sort()).toEqual(['GITLAB_TOKEN', 'JIRA_EMAIL', 'JIRA_TOKEN']);
  });

  test('omits --secret-env-vars when no secret names are configured', async () => {
    const s = setup();
    const launcher = createCopilotLauncher(s.config, { gitlab: {}, jira: {}, envNames: [] });
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...process.env, FAKE_COPILOT_MODE: 'no-result', FAKE_COPILOT_RECORD: s.record },
    });
    await proc.exited;
    const rec = JSON.parse(fs.readFileSync(s.record, 'utf8')) as Recorded;
    expect(rec.argv).not.toContain('--secret-env-vars');
  });

  test('passes --session-id when a sessionId is given', async () => {
    const s = setup();
    const launcher = createCopilotLauncher(s.config, resolveSecrets(s.config, {}));
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...process.env, FAKE_COPILOT_MODE: 'no-result', FAKE_COPILOT_RECORD: s.record },
      sessionId: 'abc-123',
    });
    await proc.exited;
    const rec = JSON.parse(fs.readFileSync(s.record, 'utf8')) as Recorded;
    const i = rec.argv.indexOf('--session-id');
    expect(i).toBeGreaterThan(-1);
    expect(rec.argv[i + 1]).toBe('abc-123');
  });

  test('omits --session-id when none is given', async () => {
    const s = setup();
    const launcher = createCopilotLauncher(s.config, resolveSecrets(s.config, {}));
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...process.env, FAKE_COPILOT_MODE: 'no-result', FAKE_COPILOT_RECORD: s.record },
    });
    await proc.exited;
    const rec = JSON.parse(fs.readFileSync(s.record, 'utf8')) as Recorded;
    expect(rec.argv).not.toContain('--session-id');
  });

  test('appends child output to logPath and reports nonzero exit', async () => {
    const s = setup();
    fs.writeFileSync(s.logPath, 'previous\n');
    const launcher = createCopilotLauncher(s.config, resolveSecrets(s.config, {}));
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...process.env, FAKE_COPILOT_MODE: 'bogus' },
    });
    expect(await proc.exited).toEqual({ code: 2, signal: null });
    expect(fs.readFileSync(s.logPath, 'utf8')).toBe('previous\nfake-copilot: unknown mode bogus\n');
  });

  test('kill terminates whole process group', async () => {
    const s = setup();
    const launcher = createCopilotLauncher(s.config, resolveSecrets(s.config, {}));
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: { ...process.env, FAKE_COPILOT_MODE: 'hang', FAKE_COPILOT_CHILD_PID_FILE: s.childPidFile },
    });
    expect(
      await waitFor(() => fs.existsSync(s.childPidFile) && fs.readFileSync(s.childPidFile, 'utf8') !== '', 5000),
    ).toBe(true);
    const childPid = Number(fs.readFileSync(s.childPidFile, 'utf8'));
    expect(isAlive(proc.pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    proc.kill('SIGTERM');
    expect(await proc.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await waitFor(() => !isAlive(proc.pid) && !isAlive(childPid), 2000)).toBe(true);
    expect(fs.existsSync(s.transcriptPath)).toBe(false);
    expect(() => proc.kill('SIGKILL')).not.toThrow();
  });

  test('missing binary resolves exited with spawnError', async () => {
    const s = setup({ copilotBin: '/nonexistent/copilot' });
    const launcher = createCopilotLauncher(s.config, resolveSecrets(s.config, {}));
    const proc = launcher.start({
      cwd: s.repo,
      prompt: 'hi',
      model: 'm1',
      transcriptPath: s.transcriptPath,
      logPath: s.logPath,
      env: process.env,
    });
    const exit = await proc.exited;
    expect(exit.code).toBeNull();
    expect(exit.signal).toBeNull();
    expect(exit.spawnError).toContain('ENOENT');
    expect(proc.pid).toBe(0);
    expect(() => proc.kill('SIGTERM')).not.toThrow();
  });
});

describe('childEnv', () => {
  test('removes secret names and keeps the rest', () => {
    const env = childEnv({ A: '1', GITLAB_TOKEN: 's', B: '2' }, { gitlab: {}, jira: {}, envNames: ['GITLAB_TOKEN'] });
    expect(env).toEqual({ A: '1', B: '2' });
  });
});
