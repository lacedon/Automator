import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readEditableConfig } from '@core/index';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
const requestHeaders = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ headers: requestHeaders }));

const { saveConfig } = await import('./config');

const tempRoot = path.resolve('test-results', 'tmp');
let configDir: string;
let configPath: string;

const config = {
  dataDir: './data',
  copilotBin: 'copilot',
  repositories: {
    pages: { folder: './pages', gitlab: 'corp', jira: 'corp', validate: ['npm test'] },
  },
  gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
  jira: {
    enabled: true,
    connections: {
      corp: {
        baseUrl: 'https://jira.example.com',
        emailEnv: 'JIRA_EMAIL',
        tokenEnv: 'JIRA_TOKEN',
        doneStatusIds: ['100'],
      },
    },
  },
  schedule: {
    intervals: { mr: '15m', default: '2h' },
    workingHours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' },
  },
  runs: {
    timeoutMinutes: 30,
    defaultModel: 'claude-sonnet-4.5',
    models: ['claude-sonnet-4.5'],
    initialReview: 'baseline-only',
    denyTools: [],
  },
  cleanup: { enabled: true, everyDays: 7, retainClosedDays: 30 },
  teams: { chatId: '19:abc@thread.v2', tool: 'teams-global(send_chat_message)', dashboardUrl: 'http://127.0.0.1:4317' },
};

function form(config: unknown): FormData {
  const data = new FormData();
  data.set('config', JSON.stringify(config));
  return data;
}

function writeConfig(): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
  configDir = fs.mkdtempSync(path.join(tempRoot, 'settings-config-'));
  configPath = path.join(configDir, 'automator.config.json');
  writeConfig();
  vi.stubEnv('AUTOMATOR_CONFIG', configPath);
  holder.core = { config: { configDir } };
  revalidatePath.mockClear();
  requestHeaders.mockResolvedValue(new Headers({ host: 'localhost:4317' }));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test('saveConfig writes valid edits and revalidates the Settings layout', async () => {
  const edited = readEditableConfig(configPath);
  edited.copilotBin = '/opt/copilot';

  expect(await saveConfig(null, form(edited))).toBeNull();
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).copilotBin).toBe('/opt/copilot');
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('saveConfig displays schema errors and preserves submitted editable values', async () => {
  const edited = readEditableConfig(configPath);
  edited.runs!.timeoutMinutes = 0;

  const result = await saveConfig(null, form(edited));

  expect(result).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'config', message: expect.stringContaining('runs.timeoutMinutes') },
    values: { runs: { timeoutMinutes: 0 } },
  });
  expect(JSON.stringify(result)).not.toMatch(/tokenEnv|emailEnv|GITLAB_TOKEN|JIRA_TOKEN/);
  expect(revalidatePath).not.toHaveBeenCalled();

  const injected = readEditableConfig(configPath);
  Object.assign(injected.runs!, { models: [{ tokenEnv: 'ATTACKER_TOKEN' }] });
  const rejected = await saveConfig(null, form(injected));
  expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'config' } });
  expect(JSON.stringify(rejected)).not.toMatch(/tokenEnv|ATTACKER_TOKEN/);
});

test('saveConfig displays unreadable-config errors', async () => {
  fs.rmSync(configPath);

  const result = await saveConfig(null, form({}));

  expect(result).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'config', message: expect.stringContaining('Cannot read config') },
  });
});

test('saveConfig preserves hidden credential bindings without accepting them', async () => {
  const edited = readEditableConfig(configPath);
  edited.gitlab.corp.host = 'https://gitlab-edited.example.com';

  expect(await saveConfig(null, form(edited))).toBeNull();

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(saved.gitlab.corp).toEqual({ host: 'https://gitlab-edited.example.com', tokenEnv: 'GITLAB_TOKEN' });
  expect(saved.jira.connections.corp).toMatchObject({
    emailEnv: 'JIRA_EMAIL',
    tokenEnv: 'JIRA_TOKEN',
  });

  Object.assign(edited.gitlab.corp, { tokenEnv: 'ATTACKER_TOKEN' });
  const rejected = await saveConfig(null, form(edited));
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'config' },
  });
  expect(JSON.stringify(rejected)).not.toMatch(/tokenEnv|ATTACKER_TOKEN/);
});

test.each([
  ['Host', { host: 'evil.example' }],
  ['X-Forwarded-Host', { host: 'localhost:4317', 'x-forwarded-host': 'evil.example' }],
])('saveConfig rejects a non-loopback %s header', async (_name, headerValues) => {
  requestHeaders.mockResolvedValue(new Headers(headerValues));
  const before = fs.readFileSync(configPath, 'utf8');

  const result = await saveConfig(null, form(JSON.parse(before)));

  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'request' } });
  expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  expect(revalidatePath).not.toHaveBeenCalled();
});
