import fs from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import { DataDir } from '../files/dataDir';
import { createReadModels } from '../read-models/index';
import { ProjectService } from './projectService';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const config = testConfig();
  const { db, cleanup } = tempDb();
  cleanups.push(() => {
    cleanup();
    fs.rmSync(config.configDir, { recursive: true, force: true });
  });
  const repositories = testRepositories(db, config);
  const projects = new ProjectService(db, repositories);
  const read = createReadModels({ db, config, clock: fakeClock(), dataDir: new DataDir(config.dataDir), repositories });
  return { db, projects, read };
}

describe('ProjectService', () => {
  test('creates, renames and lists Projects by name', () => {
    const { projects } = setup();
    const web = projects.create('  Web ');
    const apps = projects.create('Apps');
    expect(web).toMatchObject({ ok: true, value: { name: 'Web', repositories: [] } });
    expect(apps.ok).toBe(true);
    expect(projects.list().map((p) => p.name)).toEqual(['Apps', 'Web']);
    if (apps.ok) expect(projects.rename(apps.value.id, 'Mobile')).toMatchObject({ ok: true });
    expect(projects.list().map((p) => p.name)).toEqual(['Mobile', 'Web']);
  });

  test('stores a trimmed prompt addition per Project', () => {
    const { projects } = setup();
    const a = projects.create('Alpha');
    if (!a.ok) throw new Error('create failed');
    expect(a.value.promptAddition).toBe('');
    const set = projects.setPromptAddition(a.value.id, '  Be careful  ');
    expect(set).toMatchObject({ ok: true, value: { promptAddition: 'Be careful' } });
    expect(projects.setPromptAddition(999, 'x')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('rejects blank and duplicate names, case-insensitively', () => {
    const { projects } = setup();
    projects.create('Web');
    expect(projects.create(' ')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'name' } });
    expect(projects.create('web')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'name' } });
  });

  test('a repository belongs to one Project; assigning it elsewhere moves it', () => {
    const { projects } = setup();
    const a = projects.create('A');
    const b = projects.create('B');
    if (!a.ok || !b.ok) throw new Error('setup');
    projects.setRepositories(a.value.id, ['pages', 'api']);
    projects.setRepositories(b.value.id, ['api']);
    expect(projects.list().map((p) => [p.name, p.repositories])).toEqual([
      ['A', ['pages']],
      ['B', ['api']],
    ]);
  });

  test('unknown repositories and Projects are rejected', () => {
    const { projects } = setup();
    const a = projects.create('A');
    if (!a.ok) throw new Error('setup');
    expect(projects.setRepositories(a.value.id, ['nope'])).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_REPOSITORY', name: 'nope' },
    });

    expect(projects.setRepositories(999, [])).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(projects.delete(999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('Repository membership validation uses the SQLite list', () => {
    const { db, projects } = setup();
    const project = projects.create('A');
    if (!project.ok) throw new Error('setup');
    db.prepare('DELETE FROM repositories WHERE name = ?').run('pages');

    expect(projects.setRepositories(project.value.id, ['pages'])).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_REPOSITORY', name: 'pages', known: ['api'] },
    });
  });

  test('deleting a Project unassigns its repositories', () => {
    const { projects } = setup();
    const a = projects.create('A');
    if (!a.ok) throw new Error('setup');
    projects.setRepositories(a.value.id, ['pages']);
    expect(projects.delete(a.value.id).ok).toBe(true);
    expect(projects.list()).toEqual([]);
    expect(projects.projectOf().size).toBe(0);
  });
});

describe('Project scope in read models', () => {
  test('watch list, home, and counts are scoped to a Project, "none" or everything', () => {
    const { db, projects, read } = setup();
    const a = projects.create('A');
    if (!a.ok) throw new Error('setup');
    projects.setRepositories(a.value.id, ['pages']);
    insertWatch(db, { repository: 'pages', title: 'in A' });
    insertWatch(db, { repository: 'api', title: 'unassigned' });
    insertWatch(db, { repository: 'api', title: 'needs', state: 'needs_you' });

    const titles = (project?: number | 'none' | null) =>
      read
        .watchList({ project })
        .rows.map((r) => r.title)
        .sort();
    expect(titles()).toEqual(['in A', 'needs', 'unassigned']);
    expect(titles(null)).toEqual(['in A', 'needs', 'unassigned']);
    expect(titles(a.value.id)).toEqual(['in A']);
    expect(titles('none')).toEqual(['needs', 'unassigned']);
    expect(read.watchList({ project: a.value.id }).counts.all).toBe(1);

    expect(read.homeView(a.value.id).needsYou).toEqual([]);
    expect(read.homeView('none').needsYou.map((c) => c.title)).toEqual(['needs']);
    expect(read.navCounts(a.value.id).watches).toBe(1);
    expect(read.navCounts().watches).toBe(3);
  });

  test('form options name the Project of each repository', () => {
    const { projects, read } = setup();
    const a = projects.create('A');
    if (!a.ok) throw new Error('setup');
    projects.setRepositories(a.value.id, ['pages']);
    expect(read.formOptions().repositories.map((r) => [r.name, r.project])).toEqual([
      ['api', null],
      ['pages', 'A'],
    ]);
  });
});
