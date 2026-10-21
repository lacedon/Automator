import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import { createCore } from '../index';
import type { JiraClient } from '../prechecks/jiraClient';
import { resolveJiraDoneNames } from './jiraDoneNames';

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(statuses: JiraClient['statuses']) {
  const config = testConfig({
    jira: {
      enabled: true,
      connections: {
        corp: { baseUrl: 'https://jira.example.com', tokenEnv: 'JIRA_TOKEN', doneStatusIds: ['1', '9'] },
        other: { baseUrl: 'https://other.example.com', tokenEnv: 'JIRA_TOKEN' },
      },
    },
  });
  const clientFor = vi.fn(
    (): JiraClient => ({ myself: () => Promise.reject(new Error('unused')), issue: () => Promise.reject(new Error('unused')), statuses }),
  );
  const core = createCore(config, { jira: clientFor });
  cleanups.push(() => {
    core.close();
    fs.rmSync(path.dirname(config.dataDir), { recursive: true, force: true });
  });
  const meta = (key: string) => (core.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  return { core, clientFor, meta };
}

describe('resolveJiraDoneNames', () => {
  test('stores names per connection and marks unknown ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { core, clientFor, meta } = setup(async () => [
      { id: '1', name: 'Done' },
      { id: '2', name: 'Open' },
    ]);
    await resolveJiraDoneNames(core);
    expect(clientFor.mock.calls).toEqual([['corp']]);
    expect(JSON.parse(meta('jira_done_names:corp')!)).toEqual({ '1': 'Done', '9': '9 (unknown)' });
    expect(meta('jira_done_names:other')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Z .*9.*corp/));
  });

  test('logs failures without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { core, meta } = setup(() => Promise.reject(new Error('jira down')));
    await expect(resolveJiraDoneNames(core)).resolves.toBeUndefined();
    expect(meta('jira_done_names:corp')).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Z .*corp.*jira down/));
  });
});
