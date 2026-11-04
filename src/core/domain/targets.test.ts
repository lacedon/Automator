import { expect, test } from 'vitest';
import { createConfigSchema, type Config } from '../config/schema';
import type { Repository } from '../repositories/repositoryService';
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
  repositories: {
    pages: { folder: '/repo/pages', gitlab: 'corp', jira: 'corp', validate: [] },
    nojira: { folder: '/repo/x', gitlab: 'corp', validate: [] },
  },
};

function repositoryFor(name: string, source = config): Repository | undefined {
  const repository = source.repositories[name];
  return repository === undefined
    ? undefined
    : {
        name,
        folder: repository.folder,
        gitlab: repository.gitlab ?? null,
        github: repository.github ?? null,
        jira: repository.jira ?? null,
        validate: repository.validate,
      };
}

function parsed(input: string, name = 'pages', source = config) {
  const r = parseTarget(input, source, repositoryFor(name, source));
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
  expect(parseTarget('ABC-1', config, repositoryFor('nojira'))).toEqual({ ok: false, error });
  expect(parseTarget('ABC-1', config, repositoryFor('missing'))).toEqual({ ok: false, error });
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

test('normalizes GitHub pull request URL', () => {
  const withGithub: Config = {
    ...config,
    github: { gh: { host: 'github.com', tokenEnv: 'GITHUB_TOKEN' } },
    repositories: {
      ...config.repositories,
      pages: { ...config.repositories.pages!, github: 'gh' },
    },
  };
  const r = parseTarget(
    'https://GitHub.com/acme/app/pull/7/files?x=1#n',
    withGithub,
    repositoryFor('pages', withGithub),
  );
  expect(r).toEqual({
    ok: true,
    value: {
      kind: 'mr',
      normalizedTarget: 'github:github.com/acme/app#7',
      displayUrl: 'https://github.com/acme/app/pull/7',
      github: { conn: 'gh', host: 'github.com', owner: 'acme', repo: 'app', number: 7, apiProjectId: 'acme/app' },
    },
  });
});

test('GitHub pull request URL without a GitHub connection is a free-form target', () => {
  expect(parsed('https://github.com/acme/app/pull/7').kind).toBe('free');
});

test('MR parsing uses only the selected Repository connections', () => {
  const withMultipleConnections: Config = {
    ...config,
    repositories: {
      ...config.repositories,
      pages: { folder: '/repo/pages', gitlab: 'second', github: 'gh-second', validate: [] },
    },
    gitlab: {
      first: { host: 'https://gitlab.example.com', tokenEnv: 'FIRST_TOKEN' },
      second: { host: 'https://gitlab.example.com', tokenEnv: 'SECOND_TOKEN' },
    },
    github: {
      'gh-first': { host: 'github.example.com', tokenEnv: 'FIRST_GITHUB_TOKEN' },
      'gh-second': { host: 'github.example.com', tokenEnv: 'SECOND_GITHUB_TOKEN' },
    },
  };

  expect(
    parseTarget(
      'https://gitlab.example.com/team/app/-/merge_requests/42',
      withMultipleConnections,
      repositoryFor('pages', withMultipleConnections),
    ),
  ).toMatchObject({
    ok: true,
    value: { gitlab: { conn: 'second' } },
  });
  expect(
    parseTarget(
      'https://github.example.com/acme/app/pull/7',
      withMultipleConnections,
      repositoryFor('pages', withMultipleConnections),
    ),
  ).toMatchObject({
    ok: true,
    value: { github: { conn: 'gh-second' } },
  });
  expect(
    parseTarget(
      'https://gitlab.example.com/team/app/-/merge_requests/42',
      withMultipleConnections,
      repositoryFor('nojira', withMultipleConnections),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: 'free' },
  });
});
