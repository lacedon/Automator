import { expect, test } from 'vitest';
import { createConfigSchema, type Config } from '../config/schema';
import { parseTarget } from './targets';

const config: Config = {
  ...createConfigSchema('/cfg').parse({
    repositories: {
      pages: { folder: '/repo/pages', gitlab: 'corp', jira: 'corp' },
      nojira: { folder: '/repo/x', gitlab: 'corp' },
    },
    gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
    jira: { connections: { corp: { baseUrl: 'https://jira.example.com' } } },
  }),
  configDir: '/cfg',
};

function parsed(input: string, repository?: string) {
  const r = parseTarget(input, config, repository);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

test('normalizes MR URL', () => {
  expect(parsed('https://GitLab.example.com/team/app/-/merge_requests/42/diffs?x=1#n')).toEqual({
    kind: 'mr',
    normalizedTarget: 'gitlab:gitlab.example.com/team/app!42',
    displayUrl: 'https://gitlab.example.com/team/app/-/merge_requests/42',
    gitlab: { conn: 'corp', host: 'gitlab.example.com', projectPath: 'team/app', iid: 42, apiProjectId: 'team%2Fapp' },
  });
});

test('parses nested group MR URL and encodes project path', () => {
  const t = parsed('https://gitlab.example.com/a/b/c/-/merge_requests/7');
  expect(t.gitlab).toMatchObject({ projectPath: 'a/b/c', apiProjectId: 'a%2Fb%2Fc', iid: 7 });
  expect(t.normalizedTarget).toBe('gitlab:gitlab.example.com/a/b/c!7');
});

test('parses Jira browse URL and bare key', () => {
  const expected = {
    kind: 'jira',
    normalizedTarget: 'jira:jira.example.com/ABC-12',
    displayUrl: 'https://jira.example.com/browse/ABC-12',
    jira: { conn: 'corp', host: 'jira.example.com', key: 'ABC-12' },
  };
  expect(parsed('https://jira.example.com/browse/abc-12')).toEqual(expected);
  expect(parsed('abc-12', 'pages')).toEqual(expected);
});

test('bare key without jira repository is INVALID_TARGET', () => {
  const error = { code: 'INVALID_TARGET', message: 'Jira key needs a Repository with a Jira connection' };
  expect(parseTarget('ABC-1', config)).toEqual({ ok: false, error });
  expect(parseTarget('ABC-1', config, 'nojira')).toEqual({ ok: false, error });
  expect(parseTarget('ABC-1', config, 'missing')).toEqual({ ok: false, error });
});

test('unknown host URL is free-form', () => {
  expect(parsed('https://Example.org/Path/#frag')).toEqual({
    kind: 'free',
    normalizedTarget: 'https://example.org/Path',
    displayUrl: 'https://example.org/Path',
  });
});

test('free-form strips trailing slash on path only', () => {
  expect(parsed('https://x.org/a/?q=1').normalizedTarget).toBe('https://x.org/a?q=1');
  expect(parsed('https://x.org/a?next=/b/').normalizedTarget).toBe('https://x.org/a?next=/b/');
  expect(parsed('https://X.org/').normalizedTarget).toBe('https://x.org');
  expect(parsed('https://x.org/?q=1').normalizedTarget).toBe('https://x.org/?q=1');
  expect(parsed('https://x.org/?#f').normalizedTarget).toBe('https://x.org');
});

test('MR URL on unconfigured GitLab host is free-form', () => {
  const t = parsed('https://gitlab.other.com/team/app/-/merge_requests/42');
  expect(t.kind).toBe('free');
  expect(t.normalizedTarget).toBe('https://gitlab.other.com/team/app/-/merge_requests/42');
  expect(t.gitlab).toBeUndefined();
});

test('rejects non-http input', () => {
  for (const input of ['ftp://x', 'hello']) {
    const r = parseTarget(input, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TARGET');
  }
});
