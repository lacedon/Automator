import fs from 'node:fs';
import path from 'node:path';
import { createConfigSchema, type Config } from '../../src/core/config/schema';

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const tempRoot = path.resolve('test-results', 'tmp');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge(base: unknown, overrides: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overrides)) return overrides === undefined ? base : overrides;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) out[key] = merge(base[key], value);
  return out;
}

// Built through the real schema so defaults match production; overrides apply to the parsed output.
export function testConfig(overrides: DeepPartial<Config> = {}): Config {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'config-'));
  for (const name of ['pages', 'api']) fs.mkdirSync(path.join(root, 'repos', name), { recursive: true });
  const parsed = createConfigSchema(root).parse({
    dataDir: path.join(root, 'data'),
    repositories: {
      pages: { folder: './repos/pages', gitlab: 'corp', jira: 'corp' },
      api: { folder: './repos/api', gitlab: 'corp' },
    },
    gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
    jira: { connections: { corp: { baseUrl: 'https://jira.example.com', tokenEnv: 'JIRA_TOKEN' } } },
  });
  return merge({ ...parsed, configDir: root }, overrides) as Config;
}
