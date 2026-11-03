import { describe, expect, test } from 'vitest';
import { createConfigSchema, findReferenceIssues } from './schema';

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

  test('a repository without any connection is rejected', () => {
    const result = createConfigSchema('/cfg').safeParse({ ...base, repositories: { app: { folder: '/repo/app' } } });
    expect(result.success).toBe(false);
  });

  test('unknown github connection is reported', () => {
    const raw = { ...base, github: {} };
    expect(findReferenceIssues(raw)).toEqual([
      { path: ['repositories', 'app', 'github'], message: 'Unknown github connection "gh"' },
    ]);
  });
});
