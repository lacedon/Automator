import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { importLegacyRepositories, LEGACY_REPOSITORIES_MARKER } from './legacyImport';

const cleanups: (() => void)[] = [];

function setup() {
  const { db, file, cleanup } = tempDb();
  cleanups.push(cleanup);
  return { db, file };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const oldConfig = {
  repositories: {
    pages: { folder: './My Work/pages', gitlab: 'corp', jira: 'jira-main', validate: ['npm test'] },
    api: { folder: '~/repos/api', github: 'public' },
  },
};

describe('importLegacyRepositories', () => {
  test('imports resolved legacy rows transactionally and logs repository names only', () => {
    const { db } = setup();
    const log = vi.fn();
    importLegacyRepositories(db, oldConfig, '/config', log);

    expect(
      db.prepare('SELECT name, folder, gitlab, github, jira, validate_json FROM repositories ORDER BY name').all(),
    ).toEqual([
      {
        name: 'api',
        folder: path.join(os.homedir(), 'repos/api'),
        gitlab: null,
        github: 'public',
        jira: null,
        validate_json: '[]',
      },
      {
        name: 'pages',
        folder: '/config/My Work/pages',
        gitlab: 'corp',
        github: null,
        jira: 'jira-main',
        validate_json: '["npm test"]',
      },
    ]);
    expect(db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(LEGACY_REPOSITORIES_MARKER)).toBe('1');
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('pages');
    expect(log.mock.calls[0]?.[0]).toContain('api');
    expect(log.mock.calls[0]?.[0]).not.toContain('TOKEN');
  });

  test('does nothing when the legacy list is absent', () => {
    const { db } = setup();
    importLegacyRepositories(db, { gitlab: {} }, '/config', vi.fn());
    expect(db.prepare('SELECT COUNT(*) FROM repositories').pluck().get()).toBe(0);
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_REPOSITORIES_MARKER)).toBeUndefined();
  });

  test('reports malformed legacy data without inserting rows or writing the marker', () => {
    const { db } = setup();
    expect(() =>
      importLegacyRepositories(
        db,
        {
          repositories: {
            pages: { folder: './pages', gitlab: 'corp' },
            broken: { folder: './broken', gitlab: 'corp', validate: ['ok', 7] },
          },
        },
        '/config',
        vi.fn(),
      ),
    ).toThrow('Invalid legacy repository "broken"');
    expect(db.prepare('SELECT COUNT(*) FROM repositories').pluck().get()).toBe(0);
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_REPOSITORIES_MARKER)).toBeUndefined();
  });

  test('marker makes the import idempotent even if the config later changes', () => {
    const { db } = setup();
    importLegacyRepositories(db, oldConfig, '/config', vi.fn());
    importLegacyRepositories(
      db,
      { repositories: { changed: { folder: '/changed', github: 'new' } } },
      '/config',
      vi.fn(),
    );
    expect(db.prepare('SELECT name FROM repositories ORDER BY name').pluck().all()).toEqual(['api', 'pages']);
  });

  test('does not overwrite repositories when the table is already populated', () => {
    const { db } = setup();
    db.prepare(
      `INSERT INTO repositories (name, folder, gitlab, github, jira, validate_json)
       VALUES ('stored', '/stored', 'corp', NULL, NULL, '[]')`,
    ).run();
    importLegacyRepositories(db, oldConfig, '/config', vi.fn());
    expect(db.prepare('SELECT name FROM repositories').pluck().all()).toEqual(['stored']);
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_REPOSITORIES_MARKER)).toBeUndefined();
  });

  test('holds an immediate transaction lock before checking import eligibility', () => {
    const { db, file } = setup();
    const competingDb = new BetterSqlite3(file);
    competingDb.pragma('busy_timeout = 0');
    cleanups.push(() => competingDb.close());
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(((callback: () => void) =>
      originalTransaction(() => {
        let error: unknown;
        try {
          competingDb.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(LEGACY_REPOSITORIES_MARKER, 'raced');
        } catch (caught) {
          error = caught;
        }
        expect((error as { code?: string } | undefined)?.code).toBe('SQLITE_BUSY');
        callback();
      })) as typeof db.transaction);

    importLegacyRepositories(db, oldConfig, '/config', vi.fn());

    expect(db.prepare('SELECT name FROM repositories ORDER BY name').pluck().all()).toEqual(['api', 'pages']);
    expect(db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(LEGACY_REPOSITORIES_MARKER)).toBe('1');
  });
});
