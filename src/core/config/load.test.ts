import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ConfigError, loadConfig, loadDotenv, resolveSecrets } from './load';

const tempRoot = path.resolve('test-results', 'tmp');
const tempDirs: string[] = [];

function writeConfig(content: unknown): { dir: string; file: string } {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'config-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'automator.config.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return { dir, file };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fullConfig = {
  repositories: {
    pages: { folder: '~/My Work/pages', gitlab: 'corp', jira: 'corp', validate: ['npm test'] },
  },
  gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
  jira: {
    enabled: true,
    connections: {
      corp: { baseUrl: 'https://jira.example.com', emailEnv: 'JIRA_EMAIL', tokenEnv: 'JIRA_TOKEN' },
      other: { baseUrl: 'https://jira2.example.com', doneStatusIds: [] },
    },
  },
};

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected function to throw');
}

describe('loadConfig', () => {
  test('applies defaults', () => {
    const { dir, file } = writeConfig({ repositories: {}, gitlab: {} });
    const config = loadConfig({ path: file, env: {} });
    expect(config.schedule.intervals.mr).toBe(900_000);
    expect(config.schedule.intervals.default).toBe(7_200_000);
    expect(config.schedule.workingHours).toEqual({ days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' });
    expect(config.runs.timeoutMs).toBe(1_800_000);
    expect(config.runs.initialReview).toBe('baseline-only');
    expect(config.runs.denyTools).toEqual([]);
    expect(config.jira.enabled).toBe(false);
    expect(config.cleanup).toEqual({ enabled: true, everyDays: 7, retainClosedDays: 30 });
    expect(config.dataDir).toBe(path.join(os.homedir(), '.automator'));
    expect(config.copilotBin).toBe('copilot');
    expect(config.prompts.dir).toBe(path.join(dir, 'prompts'));
    expect(config.configDir).toBe(dir);
    expect(config.teams).toBeUndefined();
  });

  test('applies teams defaults when teams is present', () => {
    const { file } = writeConfig({ repositories: {}, gitlab: {}, teams: { chatId: '19:abc@thread.v2' } });
    const config = loadConfig({ path: file, env: {} });
    expect(config.teams).toEqual({
      chatId: '19:abc@thread.v2',
      tool: 'teams-global(send_chat_message)',
      dashboardUrl: 'http://127.0.0.1:4317',
    });
  });

  test('rejects empty teams.chatId', () => {
    const { file } = writeConfig({ repositories: {}, gitlab: {}, teams: { chatId: '' } });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('teams.chatId');
  });

  test('expands ~ and keeps spaces in repository folder', () => {
    const { dir, file } = writeConfig({
      ...fullConfig,
      repositories: {
        pages: { folder: '~/My Work/pages', gitlab: 'corp', validate: [] },
        local: { folder: './x', gitlab: 'corp', validate: [] },
      },
    });
    const config = loadConfig({ path: file, env: {} });
    expect(config.repositories.pages.folder).toBe(path.join(os.homedir(), 'My Work/pages'));
    expect(config.repositories.local.folder).toBe(path.join(dir, 'x'));
  });

  test('rejects unknown connection reference', () => {
    const { file } = writeConfig({
      ...fullConfig,
      repositories: { pages: { folder: '/x', gitlab: 'nope', validate: [] } },
    });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('repositories.pages.gitlab');
  });

  test('rejects unknown jira connection reference', () => {
    const { file } = writeConfig({
      ...fullConfig,
      repositories: { pages: { folder: '/x', gitlab: 'corp', jira: 'nope', validate: [] } },
    });
    expect(() => loadConfig({ path: file, env: {} })).toThrow('repositories.pages.jira');
  });

  test('reports unknown connection references together with other issues', () => {
    const { file } = writeConfig({
      ...fullConfig,
      copilotBin: 42,
      repositories: { pages: { folder: '/x', gitlab: 'nope', jira: 'missing', validate: [] } },
    });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('copilotBin');
    expect(error.message).toContain('repositories.pages.gitlab');
    expect(error.message).toContain('repositories.pages.jira');
  });

  test('reference check tolerates malformed repositories and connections', () => {
    const { file } = writeConfig({ repositories: { a: 'oops', b: { gitlab: 7 } }, gitlab: 'nope', jira: 5 });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('repositories.a');
    expect(error.message).toContain('gitlab');
  });

  test('reports all issues at once', () => {
    const { file } = writeConfig({
      repositories: {},
      gitlab: {},
      copilotBin: 42,
      runs: { initialReview: 'everything' },
    });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('copilotBin');
    expect(error.message).toContain('runs.initialReview');
  });

  test('rejects zero or invalid durations and non-positive integers', () => {
    const { file } = writeConfig({
      repositories: {},
      gitlab: {},
      schedule: { intervals: { mr: '0m', default: 'soon' } },
      runs: { timeoutMinutes: 0 },
      cleanup: { everyDays: 1.5, retainClosedDays: -1 },
    });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    for (const p of [
      'schedule.intervals.mr',
      'schedule.intervals.default',
      'runs.timeoutMinutes',
      'cleanup.everyDays',
      'cleanup.retainClosedDays',
    ]) {
      expect(error.message).toContain(p);
    }
  });

  test('rejects empty or duplicate working days, start >= end and empty default model', () => {
    for (const [workingHours, issue] of [
      [{ days: [] }, 'schedule.workingHours.days: At least one working day is required'],
      [{ days: [1, 1] }, 'schedule.workingHours.days: Working days must not repeat'],
      [{ start: '19:00', end: '08:00' }, 'schedule.workingHours.end: Must be later than start (19:00)'],
      [{ start: '09:00', end: '09:00' }, 'schedule.workingHours.end: Must be later than start (09:00)'],
    ] as const) {
      const { file } = writeConfig({ repositories: {}, gitlab: {}, schedule: { workingHours } });
      const error = captureError(() => loadConfig({ path: file, env: {} }));
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain(issue);
    }

    const { file } = writeConfig({ repositories: {}, gitlab: {}, runs: { defaultModel: '' } });
    const error = captureError(() => loadConfig({ path: file, env: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('runs.defaultModel');

    const valid = writeConfig({ repositories: {}, gitlab: {}, schedule: { workingHours: { days: [0], start: '00:00', end: '00:01' } } });
    expect(loadConfig({ path: valid.file, env: {} }).schedule.workingHours).toEqual({ days: [0], start: '00:00', end: '00:01' });
  });

  test('missing folder is not a load error', () => {
    const { file } = writeConfig({
      ...fullConfig,
      repositories: { pages: { folder: '/definitely/does/not/exist', gitlab: 'corp', validate: [] } },
    });
    expect(loadConfig({ path: file, env: {} }).repositories.pages.folder).toBe('/definitely/does/not/exist');
  });

  test('doneStatusIds distinguishes absent from empty', () => {
    const { file } = writeConfig(fullConfig);
    const config = loadConfig({ path: file, env: {} });
    expect(config.jira.connections.corp.doneStatusIds).toBeUndefined();
    expect(config.jira.connections.other.doneStatusIds).toEqual([]);
  });

  test('AUTOMATOR_CONFIG overrides default path', () => {
    const { file } = writeConfig({ repositories: {}, gitlab: {}, copilotBin: '/opt/fake-copilot' });
    const config = loadConfig({ env: { AUTOMATOR_CONFIG: file } });
    expect(config.copilotBin).toBe('/opt/fake-copilot');
  });

  test('missing or malformed file is a ConfigError', () => {
    const { dir, file } = writeConfig({});
    expect(() => loadConfig({ path: path.join(dir, 'nope.json'), env: {} })).toThrow(ConfigError);
    fs.writeFileSync(file, '{ not json');
    expect(() => loadConfig({ path: file, env: {} })).toThrow(ConfigError);
  });

  test('example config is valid', () => {
    const config = loadConfig({ path: 'automator.config.example.json', env: {} });
    expect(config.runs.models).toEqual(['claude-sonnet-4.5', 'gpt-5']);
    expect(config.teams?.chatId).toBe('19:abc@thread.v2');
  });
});

describe('resolveSecrets', () => {
  test('resolveSecrets reads env names', () => {
    const { file } = writeConfig(fullConfig);
    const config = loadConfig({ path: file, env: {} });
    const secrets = resolveSecrets(config, { GITLAB_TOKEN: 'abc', JIRA_TOKEN: 'jt' });
    expect(secrets.gitlab.corp).toBe('abc');
    expect(secrets.jira.corp).toEqual({ email: undefined, token: 'jt' });
    expect(secrets.jira.other).toEqual({ email: undefined, token: undefined });
    expect(secrets.envNames).toEqual(expect.arrayContaining(['GITLAB_TOKEN', 'JIRA_TOKEN', 'JIRA_EMAIL']));
  });
});

describe('loadDotenv', () => {
  test('loads .env without overriding existing env', () => {
    const { dir } = writeConfig({});
    fs.writeFileSync(path.join(dir, '.env'), 'AUTOMATOR_TEST_A=fromfile\nAUTOMATOR_TEST_B=fromfile\n');
    process.env.AUTOMATOR_TEST_A = 'existing';
    delete process.env.AUTOMATOR_TEST_B;
    try {
      loadDotenv(dir);
      expect(process.env.AUTOMATOR_TEST_A).toBe('existing');
      expect(process.env.AUTOMATOR_TEST_B).toBe('fromfile');
    } finally {
      delete process.env.AUTOMATOR_TEST_A;
      delete process.env.AUTOMATOR_TEST_B;
    }
  });

  test('missing .env is ignored', () => {
    const { dir } = writeConfig({});
    expect(() => loadDotenv(dir)).not.toThrow();
  });
});
