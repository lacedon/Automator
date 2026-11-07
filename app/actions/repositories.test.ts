import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core, type RepositoryInput } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidate = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath: revalidate }));

const { createRepository, updateRepository, deleteRepository } = await import('./repositories');

let core: Core;

beforeEach(() => {
  const config = testConfig();
  core = createCore(
    config,
    { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } },
    { repositories: config.repositories },
  );
  holder.core = core;
  revalidate.mockClear();
});

afterEach(() => core.close());

function form(input: Partial<RepositoryInput> = {}): FormData {
  const data = new FormData();
  data.set('name', input.name ?? 'new-repo');
  data.set('folder', input.folder ?? core.repositories.get('api')!.folder);
  data.set('gitlab', input.gitlab ?? 'corp');
  data.set('github', input.github ?? '');
  data.set('jira', input.jira ?? '');
  data.set('validate', (input.validate ?? []).join('\n'));
  return data;
}

test('creates a Repository and revalidates the layout', async () => {
  expect(await createRepository(null, form({ name: 'fresh' }))).toBeNull();
  expect(core.repositories.get('fresh')).toMatchObject({ name: 'fresh', gitlab: 'corp', validate: [] });
  expect(revalidate).toHaveBeenCalledWith('/', 'layout');
});

test('keeps form values and rejects blank names and folders', async () => {
  expect(await createRepository(null, form({ name: ' ' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'name' },
    values: { name: ' ' },
  });
  expect(await createRepository(null, form({ folder: ' ' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'folder' },
  });
  const malformedName = form();
  malformedName.set('name', new File(['invalid'], 'name.txt'));
  expect(await createRepository(null, malformedName)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'name' },
  });
  const malformedFolder = form();
  malformedFolder.set('folder', new File(['invalid'], 'folder.txt'));
  expect(await createRepository(null, malformedFolder)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'folder' },
  });
});

test('rejects missing folders and unknown connections', async () => {
  expect(await createRepository(null, form({ folder: './does-not-exist' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'folder' },
  });
  expect(await createRepository(null, form({ github: 'unknown' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'github' },
  });
});

test('rejects a case-insensitive duplicate name', async () => {
  expect(await createRepository(null, form({ name: 'PAGES' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'name' },
  });
});

test('updates repository fields without returning secret or environment bindings', async () => {
  const current = core.repositories.get('pages')!;
  const updated = { ...current, name: 'Pages-renamed', validate: ['npm test', 'npm run check'] };
  const result = await updateRepository(current.name, updated);
  expect(result).toEqual({ ok: true });
  expect(core.repositories.get('Pages-renamed')).toMatchObject(updated);
  expect(JSON.stringify(result)).not.toMatch(/token|emailEnv|GITLAB_TOKEN|JIRA_TOKEN/i);
  expect(revalidate).toHaveBeenCalledWith('/', 'layout');
});

test('rejects updates for an unknown Repository', async () => {
  expect(
    await updateRepository('missing', {
      name: 'missing',
      folder: '/missing',
      gitlab: 'corp',
      github: null,
      jira: null,
      validate: [],
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('deletes an unreferenced Repository and revalidates', async () => {
  expect(await deleteRepository('api')).toEqual({ ok: true });
  expect(core.repositories.get('api')).toBeNull();
  expect(revalidate).toHaveBeenCalledWith('/', 'layout');
});

test('keeps a Repository and reports the Automation reference when deletion is blocked', async () => {
  core.db
    .prepare(
      `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, created_at, updated_at)
       VALUES ('free', 'https://example.com', 'https://example.com', 'pages', 'Example', 'active', 1, 1)`,
    )
    .run();
  expect(await deleteRepository('pages')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(core.repositories.get('pages')).not.toBeNull();
  expect(revalidate).not.toHaveBeenCalled();
});
