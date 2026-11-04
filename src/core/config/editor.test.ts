import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { EditableConfig } from './editor';
import { readEditableConfig, writeEditableConfig } from './editor';

const tempRoot = path.resolve('test-results', 'tmp');
const tempDirs: string[] = [];

function writeConfig(content: unknown): { dir: string; file: string } {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'editor-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'automator.config.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return { dir, file };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const config = {
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
};

function unchangedAfterFailure(file: string, operation: () => void): void {
  const before = fs.readFileSync(file, 'utf8');
  expect(operation).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
}

describe('readEditableConfig', () => {
  test('legacy config exposes defaults for every provider', () => {
    const { file } = writeConfig(config);

    const editable = readEditableConfig(file);

    expect(editable).toMatchObject({
      provider: 'copilot',
      providers: {
        'claude-code': { bin: 'claude', defaultModel: '', models: [] },
        codex: { bin: 'codex', defaultModel: '', models: [] },
        opencode: { bin: 'opencode', defaultModel: '', models: [] },
      },
    });
  });

  test('provider settings round-trip without exposing credentials', () => {
    const { file } = writeConfig({
      ...config,
      provider: 'codex',
      providers: {
        'claude-code': { bin: 'claude', defaultModel: '', models: [] },
        codex: {
          bin: '/opt/codex',
          defaultModel: 'codex-model',
          models: ['codex-model'],
          apiKeyEnv: 'OPENAI_API_KEY',
        },
        opencode: { bin: 'opencode', defaultModel: '', models: [] },
      },
    });
    const editable = readEditableConfig(file);
    expect(JSON.stringify(editable)).not.toContain('OPENAI_API_KEY');
    Object.assign(editable, {
      provider: 'codex',
      providers: {
        'claude-code': { bin: 'claude', defaultModel: '', models: [] },
        codex: { bin: '/opt/codex-edited', defaultModel: 'codex-new', models: ['codex-new'] },
        opencode: { bin: 'opencode', defaultModel: '', models: [] },
      },
    });

    writeEditableConfig(file, editable);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      provider: 'codex',
      providers: {
        codex: { bin: '/opt/codex-edited', defaultModel: 'codex-new', models: ['codex-new'] },
      },
    });
  });

  test('returns only non-secret connection fields without reading .env values', () => {
    const { dir, file } = writeConfig(config);
    fs.writeFileSync(path.join(dir, '.env'), 'GITLAB_TOKEN=private-sentinel\nJIRA_TOKEN=private-sentinel\n');

    const editable = readEditableConfig(file);

    expect(editable.gitlab).toEqual({ corp: { host: 'https://gitlab.example.com' } });
    expect(editable.jira).toEqual({
      enabled: true,
      connections: { corp: { baseUrl: 'https://jira.example.com', doneStatusIds: ['100'] } },
    });
    expect(editable.gitlab.corp).not.toHaveProperty('tokenEnv');
    expect(editable.jira.connections.corp).not.toHaveProperty('emailEnv');
    expect(editable.jira.connections.corp).not.toHaveProperty('tokenEnv');
    expect(JSON.stringify(editable)).not.toContain('Env');
    expect(JSON.stringify(editable)).not.toContain('private-sentinel');
  });

  test('does not expose removed prompt configuration', () => {
    const { file } = writeConfig({ ...config, prompts: { dir: './legacy-prompts' } });

    const editable = readEditableConfig(file);

    expect(editable).not.toHaveProperty('prompts');
  });

  test('does not expose legacy repositories', () => {
    const { file } = writeConfig(config);
    expect(readEditableConfig(file)).not.toHaveProperty('repositories');
  });
});

describe('writeEditableConfig', () => {
  test('saves allowed edits and preserves hidden connection bindings', () => {
    const { file } = writeConfig(config);
    const editable = readEditableConfig(file);
    editable.gitlab.corp.host = 'https://gitlab-edited.example.com';
    editable.jira.connections.corp.baseUrl = 'https://jira-edited.example.com';
    editable.jira.connections.corp.doneStatusIds = [];
    Object.assign(editable.gitlab.corp, { tokenEnv: 'ATTACKER_TOKEN' });
    Object.assign(editable.jira.connections.corp, { emailEnv: 'ATTACKER_EMAIL', tokenEnv: 'ATTACKER_TOKEN' });

    writeEditableConfig(file, editable);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      gitlab: {
        corp: { host: 'https://gitlab-edited.example.com', tokenEnv: 'GITLAB_TOKEN' },
      },
      jira: {
        enabled: true,
        connections: {
          corp: {
            baseUrl: 'https://jira-edited.example.com',
            emailEnv: 'JIRA_EMAIL',
            tokenEnv: 'JIRA_TOKEN',
            doneStatusIds: [],
          },
        },
      },
      repositories: config.repositories,
    });
  });

  test('rejects invalid schema edits without overwriting the file', () => {
    const { file } = writeConfig(config);
    const editable = readEditableConfig(file);
    const invalid = { ...editable, runs: { timeoutMinutes: 0 } } as EditableConfig;

    unchangedAfterFailure(file, () => writeEditableConfig(file, invalid));
  });

  test('does not overwrite legacy repositories when saving config edits', () => {
    const { file } = writeConfig(config);
    const editable = readEditableConfig(file);
    editable.copilotBin = '/opt/copilot';
    writeEditableConfig(file, editable);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).repositories).toEqual(config.repositories);
  });

  test('rejects added or removed connection records without overwriting the file', () => {
    const { file } = writeConfig(config);
    const editable = readEditableConfig(file);
    const added = {
      ...editable,
      gitlab: { ...editable.gitlab, other: { host: 'https://other.example.com' } },
    } as EditableConfig;

    unchangedAfterFailure(file, () => writeEditableConfig(file, added));

    const removed = { ...editable, gitlab: {} } as EditableConfig;
    unchangedAfterFailure(file, () => writeEditableConfig(file, removed));
  });
});
