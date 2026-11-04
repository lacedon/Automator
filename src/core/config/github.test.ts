import { describe, expect, test } from 'vitest';
import { createConfigSchema } from './schema';

const base = {
  repositories: { app: { folder: '/repo/app', github: 'gh' } },
  github: { gh: { tokenEnv: 'GH_TOKEN' } },
};

describe('github connections', () => {
  test('a repository may use only GitHub; the host defaults to github.com', () => {
    const config = createConfigSchema('/cfg').parse(base);
    expect(config.github.gh).toEqual({ host: 'github.com', tokenEnv: 'GH_TOKEN' });
    expect(config.gitlab).toEqual({});
  });

  test('legacy repository data is ignored by the runtime schema', () => {
    const result = createConfigSchema('/cfg').safeParse({ ...base, repositories: { app: { folder: '/repo/app' } } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('repositories');
  });

  test('legacy repository connection references do not affect runtime config', () => {
    const config = createConfigSchema('/cfg').parse({ ...base, github: {} });
    expect(config).not.toHaveProperty('repositories');
  });
});
