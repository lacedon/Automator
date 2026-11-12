import BetterSqlite3 from 'better-sqlite3';
import type { Database } from './open';
import { afterEach, describe, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { migrate } from './migrate';
import { migrations } from './migrations';
import { toNeedsYouEvent, toRun, toWatch } from './rows';

const cleanups: (() => void)[] = [];
const workflowTypes = ['mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc'] as const;

function setup(): Database {
  const t = tempDb();
  cleanups.push(t.cleanup);
  return t.db;
}

function setupVersion3(): Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  for (const { version, sql } of migrations.filter(({ version }) => version <= 3)) {
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  }
  cleanups.push(() => db.close());
  return db;
}

function setupVersion4(): Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  for (const { version, sql } of migrations.filter(({ version }) => version <= 4)) {
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  }
  cleanups.push(() => db.close());
  return db;
}

function setupVersion6(): Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  for (const { version, sql } of migrations.filter(({ version }) => version <= 6)) {
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  }
  cleanups.push(() => db.close());
  return db;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const T = Date.parse('2026-10-21T10:00:00');

function insertWatch(db: Database, state = 'active', target = 'gitlab:gitlab.example.com/g/p!1'): number {
  const info = db
    .prepare(
      `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, created_at, updated_at)
       VALUES ('mr', 'https://gitlab.example.com/g/p/-/merge_requests/1', ?, 'pages', 'Title', ?, ?, ?)`,
    )
    .run(target, state, T, T);
  return Number(info.lastInsertRowid);
}

function insertRun(db: Database, watchId: number | null, status: string): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at)
       VALUES (?, 'pages', ?, 'schedule', 1, 'new comment', 'm', ?)`,
    )
    .run(watchId, status, T);
  return Number(info.lastInsertRowid);
}

function insertLegacyRun(db: Database, input: { watchId?: number; ticketKey?: string; parentRunId?: number }): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, ticket_key, parent_run_id, model, queued_at)
       VALUES (?, 'pages', 'finished', ?, 0, 'old run', ?, ?, 'm', ?)`,
    )
    .run(
      input.watchId ?? null,
      input.watchId === undefined ? 'adhoc' : 'schedule',
      input.ticketKey ?? null,
      input.parentRunId ?? null,
      T,
    );
  return Number(info.lastInsertRowid);
}

function constraintCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('db', () => {
  test('existing Runs migrate to Copilot and provider values round-trip', () => {
    const db = setupVersion6();
    const oldRunId = insertRun(db, null, 'finished');

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(oldRunId))).toMatchObject({
      id: oldRunId,
      provider: 'copilot',
    });
    db.prepare("UPDATE runs SET provider = 'codex' WHERE id = ?").run(oldRunId);
    expect(toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(oldRunId)).provider).toBe('codex');
    expect(constraintCode(() => db.prepare("UPDATE runs SET provider = 'other' WHERE id = ?").run(oldRunId))).toBe(
      'SQLITE_CONSTRAINT_CHECK',
    );
  });

  test('migrate is idempotent and sets user_version 19', () => {
    const db = setup();
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(db.pragma('table_info(repositories)')).toEqual([
      expect.objectContaining({ name: 'name' }),
      expect.objectContaining({ name: 'folder' }),
      expect.objectContaining({ name: 'gitlab' }),
      expect.objectContaining({ name: 'github' }),
      expect.objectContaining({ name: 'jira' }),
      expect.objectContaining({ name: 'validate_json' }),
      expect.objectContaining({ name: 'prompt_addition' }),
    ]);
    expect(db.pragma('table_info(runs)')).toContainEqual(
      expect.objectContaining({ name: 'provider', dflt_value: "'copilot'" }),
    );
    expect(db.pragma('table_info(agents)')).toEqual([
      expect.objectContaining({ name: 'id' }),
      expect.objectContaining({ name: 'name' }),
      expect.objectContaining({ name: 'instructions' }),
      expect.objectContaining({ name: 'created_at' }),
      expect.objectContaining({ name: 'updated_at' }),
      expect.objectContaining({ name: 'allow_all_tools' }),
      expect.objectContaining({ name: 'allowed_tools' }),
      expect.objectContaining({ name: 'blocked_tools' }),
    ]);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .pluck()
      .all();
    expect(tables).toEqual([
      'agent_assignments',
      'agents',
      'api_tokens',
      'meta',
      'needs_you_events',
      'operation_templates',
      'project_repositories',
      'projects',
      'repositories',
      'role_assignments',
      'role_permissions',
      'roles',
      'runs',
      'sessions',
      'user_credentials',
      'users',
      'watches',
      'worker_lock',
    ]);
  });

  test('migration 4 seeds an empty default Agent for each Workflow type', () => {
    const db = setup();
    const defaults = db
      .prepare(
        `SELECT assignment.workflow_type AS workflowType, agent.name, agent.instructions
         FROM agent_assignments AS assignment
         JOIN agents AS agent ON agent.id = assignment.agent_id
         WHERE assignment.repository IS NULL ORDER BY assignment.workflow_type`,
      )
      .all();
    expect(defaults).toEqual(
      [...workflowTypes].sort().map((workflowType) => ({
        workflowType,
        name: 'Default',
        instructions: '',
      })),
    );
    expect(db.prepare('SELECT COUNT(*) FROM agents').pluck().get()).toBe(workflowTypes.length);
    expect(db.prepare('SELECT workflow_type FROM operation_templates ORDER BY workflow_type').pluck().all()).toEqual(
      [],
    );
  });

  test('assignment slots are unique and a null repository Agent is an explicit override', () => {
    const db = setup();
    const agentId = db
      .prepare("SELECT agent_id FROM agent_assignments WHERE repository IS NULL AND workflow_type = 'mr-watch'")
      .pluck()
      .get() as number;
    const insertAssignment = db.prepare(
      'INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, ?)',
    );
    expect(constraintCode(() => insertAssignment.run(null, 'mr-watch', agentId))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(() => insertAssignment.run('pages', 'mr-watch', null)).not.toThrow();
    expect(constraintCode(() => insertAssignment.run('pages', 'mr-watch', agentId))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(
      db
        .prepare("SELECT agent_id FROM agent_assignments WHERE repository = 'pages' AND workflow_type = 'mr-watch'")
        .pluck()
        .get(),
    ).toBeNull();
    db.prepare("DELETE FROM agent_assignments WHERE repository = 'pages' AND workflow_type = 'mr-watch'").run();
    expect(
      db.prepare("SELECT 1 FROM agent_assignments WHERE repository = 'pages' AND workflow_type = 'mr-watch'").get(),
    ).toBeUndefined();
  });

  test('migration 5 preserves Agents and assignments while making Agents workflow-neutral', () => {
    const db = setupVersion4();
    const customAgentId = Number(
      db
        .prepare(
          `INSERT INTO agents (workflow_type, name, instructions, created_at, updated_at)
           VALUES ('mr-watch', 'Custom', 'Keep these instructions', ?, ?)`,
        )
        .run(T, T + 1).lastInsertRowid,
    );
    db.prepare('INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, ?)').run(
      'pages',
      'mr-watch',
      customAgentId,
    );
    db.prepare('INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, NULL)').run(
      'pages',
      'jira-watch',
    );
    const agentsBefore = db
      .prepare('SELECT id, name, instructions, created_at, updated_at FROM agents ORDER BY id')
      .all();
    const assignmentsBefore = db
      .prepare('SELECT repository, workflow_type, agent_id FROM agent_assignments ORDER BY repository, workflow_type')
      .all();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(db.pragma('table_info(agents)')).not.toContainEqual(expect.objectContaining({ name: 'workflow_type' }));
    expect(db.prepare('SELECT id, name, instructions, created_at, updated_at FROM agents ORDER BY id').all()).toEqual(
      agentsBefore,
    );
    expect(
      db
        .prepare('SELECT repository, workflow_type, agent_id FROM agent_assignments ORDER BY repository, workflow_type')
        .all(),
    ).toEqual(assignmentsBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.prepare('DELETE FROM agents WHERE id = ?').run(customAgentId);
    expect(
      db
        .prepare("SELECT agent_id FROM agent_assignments WHERE repository = 'pages' AND workflow_type = 'mr-watch'")
        .pluck()
        .get(),
    ).toBeNull();
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?) ORDER BY name')
        .all('index', 'ux_agent_assignment_default', 'ux_agent_assignment_repository'),
    ).toEqual([{ name: 'ux_agent_assignment_default' }, { name: 'ux_agent_assignment_repository' }]);
  });

  test('migration 4 backfills Automation, root Ad-hoc, and follow-up Workflow types', () => {
    const db = setupVersion3();
    const watchIdFor = (kind: 'mr' | 'jira' | 'free') =>
      Number(
        db
          .prepare(
            `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, created_at, updated_at)
             VALUES (?, ?, ?, 'pages', 'Title', 'active', ?, ?)`,
          )
          .run(kind, `url-${kind}`, `target-${kind}`, T, T).lastInsertRowid,
      );
    const mrRun = insertLegacyRun(db, { watchId: watchIdFor('mr') });
    const jiraRun = insertLegacyRun(db, { watchId: watchIdFor('jira') });
    const freeRun = insertLegacyRun(db, { watchId: watchIdFor('free') });
    const ticketRoot = insertLegacyRun(db, { ticketKey: 'ABC-123' });
    const freeRoot = insertLegacyRun(db, {});
    const followUp = insertLegacyRun(db, { parentRunId: ticketRoot });
    const secondFollowUp = insertLegacyRun(db, { parentRunId: followUp });

    migrate(db);

    const workflowTypeFor = (id: number) => toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id)).workflowType;
    expect([
      workflowTypeFor(mrRun),
      workflowTypeFor(jiraRun),
      workflowTypeFor(freeRun),
      workflowTypeFor(ticketRoot),
      workflowTypeFor(freeRoot),
      workflowTypeFor(followUp),
      workflowTypeFor(secondFollowUp),
    ]).toEqual(['mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc', 'ticket-adhoc', 'ticket-adhoc']);
  });

  test('migration 4 inherits the parent Workflow type even when a child has an Automation', () => {
    const db = setupVersion3();
    const watchId = insertWatch(db);
    const parentId = insertLegacyRun(db, { ticketKey: 'ABC-123' });
    const childId = insertLegacyRun(db, { watchId, parentRunId: parentId });
    const grandchildId = insertLegacyRun(db, { parentRunId: childId });

    migrate(db);

    for (const id of [parentId, childId, grandchildId]) {
      expect(toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id)).workflowType).toBe('ticket-adhoc');
    }
  });

  test('migration 3 adds session and parent columns', () => {
    const db = setup();
    const parentId = insertRun(db, null, 'finished');
    const childId = insertRun(db, null, 'finished');
    db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run(parentId, childId);
    expect(toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(parentId))).toMatchObject({
      sessionId: null,
      parentRunId: null,
    });
    expect(toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(childId))).toMatchObject({
      sessionId: null,
      parentRunId: parentId,
    });
  });

  test('deleting a parent Run nulls parent_run_id on the child', () => {
    const db = setup();
    const parentId = insertRun(db, null, 'finished');
    const childId = insertRun(db, null, 'finished');
    db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run(parentId, childId);
    db.prepare('DELETE FROM runs WHERE id = ?').run(parentId);
    expect(db.prepare('SELECT parent_run_id FROM runs WHERE id = ?').pluck().get(childId)).toBeNull();
  });

  test('pragmas applied', () => {
    const db = setup();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  test('rejects second non-closed watch for same target and repository', () => {
    const db = setup();
    insertWatch(db, 'active');
    expect(constraintCode(() => insertWatch(db, 'paused'))).toBe('SQLITE_CONSTRAINT_UNIQUE');

    const other = setup();
    insertWatch(other, 'closed');
    expect(() => insertWatch(other, 'active')).not.toThrow();
  });

  test('rejects invalid enum values', () => {
    const db = setup();
    expect(constraintCode(() => insertWatch(db, 'bogus'))).toBe('SQLITE_CONSTRAINT_CHECK');
    const watchId = insertWatch(db);
    expect(constraintCode(() => insertRun(db, watchId, 'cancelled'))).toBe('SQLITE_CONSTRAINT_CHECK');
  });

  test('allows only one queued run per watch', () => {
    const db = setup();
    const a = insertWatch(db, 'active', 'a');
    const b = insertWatch(db, 'active', 'b');
    insertRun(db, a, 'queued');
    expect(constraintCode(() => insertRun(db, a, 'queued'))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(() => insertRun(db, b, 'queued')).not.toThrow();
    expect(() => insertRun(db, null, 'queued')).not.toThrow();
    expect(() => insertRun(db, null, 'queued')).not.toThrow();
    expect(() => insertRun(db, a, 'finished')).not.toThrow();
  });

  test('allows several running runs', () => {
    const db = setup();
    const a = insertWatch(db, 'active', 'a');
    const b = insertWatch(db, 'active', 'b');
    insertRun(db, a, 'running');
    expect(() => insertRun(db, b, 'running')).not.toThrow();
    expect(() => insertRun(db, null, 'running')).not.toThrow();
  });

  test('deleting a watch cascades runs and needs_you_events', () => {
    const db = setup();
    const watchId = insertWatch(db);
    const runId = insertRun(db, watchId, 'finished');
    const adhocId = insertRun(db, null, 'finished');
    db.prepare(
      `INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status) VALUES (?, ?, 'r', ?, 'pending')`,
    ).run(watchId, runId, T);
    db.prepare('DELETE FROM watches WHERE id = ?').run(watchId);
    expect(db.prepare('SELECT id FROM runs').pluck().all()).toEqual([adhocId]);
    expect(db.prepare('SELECT COUNT(*) FROM needs_you_events').pluck().get()).toBe(0);
  });

  test('maps rows to domain objects', () => {
    const db = setup();
    const watchId = insertWatch(db);
    db.prepare(`UPDATE watches SET cursor_json = ?, interval_ms = 60000 WHERE id = ?`).run(
      JSON.stringify({ lastNoteId: 5, handledPipelineId: null, handledConflictSha: null }),
      watchId,
    );
    const watch = toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId));
    expect(watch).toMatchObject({
      id: watchId,
      kind: 'mr',
      normalizedTarget: 'gitlab:gitlab.example.com/g/p!1',
      state: 'active',
      intervalMs: 60000,
      model: null,
      cursor: { lastNoteId: 5, handledPipelineId: null, handledConflictSha: null },
      checkFailures: 0,
      createdAt: T,
    });

    const runId = insertRun(db, watchId, 'finished');
    db.prepare(`UPDATE runs SET review_unresolved = 1, error_json = ?, result_status = 'error' WHERE id = ?`).run(
      JSON.stringify({ code: 'TIMEOUT', message: 'took too long' }),
      runId,
    );
    const run = toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
    expect(run).toMatchObject({
      id: runId,
      watchId,
      status: 'finished',
      reviewUnresolved: true,
      resultStatus: 'error',
      error: { code: 'TIMEOUT', message: 'took too long' },
      cursorCandidate: null,
      outcome: null,
    });

    db.prepare(
      `INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status) VALUES (?, NULL, 'r', ?, 'disabled')`,
    ).run(watchId, T);
    const event = toNeedsYouEvent(db.prepare('SELECT * FROM needs_you_events').get());
    expect(event).toEqual({
      id: 1,
      watchId,
      runId: null,
      reason: 'r',
      createdAt: T,
      teamsStatus: 'disabled',
      teamsError: null,
    });
  });
});
