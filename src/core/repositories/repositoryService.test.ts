import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createConfigSchema, type Config } from '../config/schema';
import { tempDb, insertWatch } from '../../../test/helpers/db';
import { RepositoryService, type RepositoryInput } from './repositoryService';

const tempRoot = path.resolve('test-results', 'tmp');
const cleanups: (() => void)[] = [];

function setup() {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'repositories-'));
  fs.mkdirSync(path.join(root, 'repo'));
  const config = {
    ...createConfigSchema(root).parse({
      gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
      github: { public: { host: 'github.com', tokenEnv: 'GITHUB_TOKEN' } },
      jira: { connections: { corp: { baseUrl: 'https://jira.example.com' } } },
    }),
    configDir: root,
  } as Config;
  const { db, cleanup: closeDb } = tempDb();
  cleanups.push(() => {
    closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    config,
    root,
    service: new RepositoryService(db, config),
    input: (name = 'pages'): RepositoryInput => ({
      name,
      folder: path.join(root, 'repo'),
      gitlab: 'corp',
      github: null,
      jira: null,
      validate: ['npm test'],
    }),
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('RepositoryService', () => {
  test('creates, lists, looks up, and validates repository status', () => {
    const { service, input } = setup();
    const created = service.create(input());
    expect(created).toEqual({ ok: true, value: input() });
    expect(service.list()).toEqual([input()]);
    expect(service.get('PAGES')).toEqual(input());
    expect(service.status('pages')).toEqual([]);
    expect(service.get('missing')).toBeNull();
  });

  test('reports missing folders and configured connections by name', () => {
    const { db, service } = setup();
    db.prepare(
      `INSERT INTO repositories (name, folder, gitlab, github, jira, validate_json)
       VALUES ('broken', ?, 'missing-gitlab', NULL, 'missing-jira', '[]')`,
    ).run(path.join(tempRoot, 'missing-folder'));
    expect(service.status('broken')).toEqual([
      `Folder does not exist: ${path.join(tempRoot, 'missing-folder')}`,
      'Unknown GitLab connection "missing-gitlab"',
      'Unknown Jira connection "missing-jira"',
    ]);
  });

  test('rejects invalid connections, missing folders, and repositories without Git hosting', () => {
    const { service, input } = setup();
    expect(service.create({ ...input(), gitlab: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'gitlab' },
    });
    expect(service.create({ ...input(), github: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'github' },
    });
    expect(service.create({ ...input(), folder: path.join(tempRoot, 'missing-folder') })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'folder' },
    });
  });

  test('rejects case-insensitive duplicate names and rename collisions', () => {
    const { service, input } = setup();
    expect(service.create(input()).ok).toBe(true);
    expect(service.create(input('PAGES'))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'name' },
    });
    service.create(input('api'));
    expect(service.update('pages', input('API'))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'name' },
    });
  });

  test('renames all repository references transactionally', () => {
    const { db, service, input } = setup();
    service.create(input());
    const watchId = insertWatch(db, { repository: 'pages' });
    const runId = Number(
      db
        .prepare(
          `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
           VALUES (?, 'pages', 'finished', 'schedule', 1, 'done', 'm', 10)`,
        )
        .run(watchId).lastInsertRowid,
    );
    const projectId = Number(
      db.prepare("INSERT INTO projects (name, created_at) VALUES ('App', 10)").run().lastInsertRowid,
    );
    db.prepare('INSERT INTO project_repositories (repository, project_id) VALUES (?, ?)').run('pages', projectId);
    const agentId = db
      .prepare("SELECT id FROM agents WHERE name = 'Default' ORDER BY id LIMIT 1")
      .pluck()
      .get() as number;
    db.prepare('INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, ?)').run(
      'pages',
      'mr-watch',
      agentId,
    );

    expect(service.update('pages', input('website'))).toEqual({ ok: true, value: input('website') });
    expect(db.prepare('SELECT repository FROM watches WHERE id = ?').pluck().get(watchId)).toBe('website');
    expect(db.prepare('SELECT repository FROM runs WHERE id = ?').pluck().get(runId)).toBe('website');
    expect(db.prepare('SELECT repository FROM project_repositories WHERE project_id = ?').pluck().get(projectId)).toBe(
      'website',
    );
    expect(
      db
        .prepare("SELECT repository FROM agent_assignments WHERE repository = 'website' AND workflow_type = 'mr-watch'")
        .pluck()
        .get(),
    ).toBe('website');
  });

  test('blocks deletion while a Watch references the repository', () => {
    const { db, service, input } = setup();
    service.create(input());
    insertWatch(db);
    expect(service.delete('pages')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'name' },
    });
    expect(service.get('pages')).not.toBeNull();
  });

  test('deletes project and Agent references without deleting Runs or repository files', () => {
    const { db, service, input, root } = setup();
    service.create(input());
    const file = path.join(root, 'repo', 'keep.txt');
    fs.writeFileSync(file, 'keep');
    const runId = Number(
      db
        .prepare(
          `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
           VALUES (NULL, 'pages', 'finished', 'adhoc', 0, 'done', 'm', 10)`,
        )
        .run().lastInsertRowid,
    );
    const projectId = Number(
      db.prepare("INSERT INTO projects (name, created_at) VALUES ('App', 10)").run().lastInsertRowid,
    );
    db.prepare('INSERT INTO project_repositories (repository, project_id) VALUES (?, ?)').run('pages', projectId);
    const agentId = db
      .prepare("SELECT id FROM agents WHERE name = 'Default' ORDER BY id LIMIT 1")
      .pluck()
      .get() as number;
    db.prepare('INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, ?)').run(
      'pages',
      'mr-watch',
      agentId,
    );

    expect(service.delete('pages')).toEqual({ ok: true, value: undefined });
    expect(service.get('pages')).toBeNull();
    expect(db.prepare('SELECT id FROM runs WHERE id = ?').pluck().get(runId)).toBe(runId);
    expect(db.prepare('SELECT COUNT(*) FROM project_repositories').pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_assignments WHERE repository = 'pages'").pluck().get()).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  });
});
