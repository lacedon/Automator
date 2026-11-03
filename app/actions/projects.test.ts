import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const jar = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }));
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));

const { createProject, renameProject, deleteProject, setProjectRepositories, selectProject } =
  await import('./projects');

let core: Core;

beforeEach(() => {
  core = createCore(testConfig(), { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } });
  holder.core = core;
  jar.set.mockClear();
  jar.delete.mockClear();
});

afterEach(() => core.close());

function form(name: string): FormData {
  const data = new FormData();
  data.set('name', name);
  return data;
}

test('createProject creates, and echoes values on a duplicate or blank name', async () => {
  expect(await createProject(null, form(' Work '))).toBeNull();
  expect(core.projects.list().map((p) => p.name)).toEqual(['Work']);
  expect(await createProject(null, form('work'))).toMatchObject({ ok: false, values: { name: 'work' } });
  expect(await createProject(null, form(' '))).toMatchObject({ ok: false });
});

test('rename, set repositories and delete work through the service', async () => {
  const project = core.projects.create('A');
  if (!project.ok) throw new Error('setup');
  const id = project.value.id;
  const repo = Object.keys(core.config.repositories)[0]!;
  expect(await renameProject(id, 'B')).toEqual({ ok: true });
  expect(await setProjectRepositories(id, [repo])).toEqual({ ok: true });
  expect(core.projects.get(id)).toMatchObject({ name: 'B', repositories: [repo] });
  expect(await setProjectRepositories(id, ['nope'])).toMatchObject({ ok: false });
  expect(await deleteProject(id)).toEqual({ ok: true });
  expect(await deleteProject(id)).toMatchObject({ ok: false });
});

test('selectProject sets the scope cookie, or clears it for all', async () => {
  await selectProject('3');
  expect(jar.set).toHaveBeenCalledWith('automator-project', '3', expect.objectContaining({ path: '/' }));
  await selectProject('all');
  expect(jar.delete).toHaveBeenCalledWith('automator-project');
});
