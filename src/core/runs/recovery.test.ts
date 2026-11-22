import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import { AgentService } from '../agents/agentService';
import type { Database } from '../db/open';
import { toRun, toWatch } from '../db/rows';
import type { NeedsYouEvent } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { FreeformPrecheck } from '../prechecks/freeform';
import type { Prechecks } from '../prechecks/index';
import type { JiraPrecheck } from '../prechecks/jira';
import type { CopilotLauncher } from './copilotLauncher';
import { recoverInterruptedRuns } from './recovery';
import type { ResultFileV1 } from './runExecutor';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const config = testConfig();
  const repositories = testRepositories(t.db, config);
  const dataDir = new DataDir(config.dataDir);
  const launcher: CopilotLauncher = {
    start: () => {
      throw new Error('not used');
    },
  };
  const free = new FreeformPrecheck();
  const prechecks: Prechecks = { mr: free, jira: free as unknown as JiraPrecheck, free };
  const events: NeedsYouEvent[] = [];
  const onNeedsYou = vi.fn(async (e: NeedsYouEvent) => {
    events.push(e);
  });
  const deps = {
    db: t.db,
    agents: new AgentService(t.db),
    clock,
    config,
    repositories,
    dataDir,
    launchers: { copilot: launcher, 'claude-code': launcher, codex: launcher, opencode: launcher, pi: launcher },
    prechecks,
    currentBranch: vi.fn(async () => 'main'),
    onNeedsYou,
  };
  return { db: t.db, clock, dataDir, deps, events, onNeedsYou };
}

function insertRunning(db: Database, watchId: number | null, startedAt: number, pid: number | null = null): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at, started_at, pid)
       VALUES (?, 'pages', 'running', 'schedule', 1, 'r', 'm', ?, ?, ?)`,
    )
    .run(watchId, startedAt, startedAt, pid);
  return Number(info.lastInsertRowid);
}

describe('recoverInterruptedRuns', () => {
  test('leftover running row becomes worker-restart error and watch needs_you', async () => {
    const s = setup();
    const persistedFolder = path.join(s.deps.config.configDir, 'persisted-pages');
    fs.mkdirSync(persistedFolder);
    cleanups.push(() => fs.rmSync(persistedFolder, { recursive: true, force: true }));
    s.db.prepare('UPDATE repositories SET folder = ? WHERE name = ?').run(persistedFolder, 'pages');
    const watchId = insertWatch(s.db);
    const runId = insertRunning(s.db, watchId, s.clock.now() - 60_000);
    s.dataDir.ensureRunDir(runId);
    fs.writeFileSync(s.dataDir.copilotResultPath(runId), JSON.stringify({ outcome: 'acted', summary: 'ignored' }));

    expect(await recoverInterruptedRuns(s.deps)).toBe(1);

    const run = toRun(s.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
    expect(run).toMatchObject({
      status: 'finished',
      endedAt: s.clock.now(),
      resultStatus: 'error',
      outcome: null,
      interrupted: 'worker-restart',
      branch: 'main',
      resultPath: s.dataDir.resultPath(runId),
      transcriptPath: null,
    });
    expect(run.error?.code).toBe('INTERRUPTED');
    expect(s.deps.currentBranch).toHaveBeenCalledWith(persistedFolder);
    const result = JSON.parse(fs.readFileSync(s.dataDir.resultPath(runId), 'utf8')) as ResultFileV1;
    expect(result).toMatchObject({ schemaVersion: 1, runId, status: 'error', outcome: null, error: run.error });
    expect(toWatch(s.db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId))).toMatchObject({
      state: 'needs_you',
      needsYouRunId: runId,
    });
    expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
    expect(await recoverInterruptedRuns(s.deps)).toBe(0);
  });

  test('removes per-Run copies left behind by a crash', async () => {
    const s = setup();
    const runId = insertRunning(s.db, null, s.clock.now());
    const copy = s.dataDir.workspacePath(runId, s.deps.config.repositories.pages.folder);
    fs.mkdirSync(copy, { recursive: true });

    await recoverInterruptedRuns(s.deps);

    expect(fs.existsSync(path.dirname(copy))).toBe(false);
  });

  test('kills live process group of leftover row', async () => {
    const s = setup();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    cleanups.push(() => child.kill('SIGKILL'));
    const runId = insertRunning(s.db, null, s.clock.now(), child.pid);

    expect(await recoverInterruptedRuns(s.deps)).toBe(1);

    const [code, signal] = await exited;
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' });
    expect(toRun(s.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)).interrupted).toBe('worker-restart');
  });
});

describe('recoverInterruptedRuns: Interactive Chats', () => {
  function chat(db: Database, extra: { closeRequestedAt?: number; closedAt?: number; pid?: number } = {}): number {
    const row = db
      .prepare(
        `INSERT INTO chat_sessions (mode, repository, provider, model, created_at, last_activity_at, close_requested_at, closed_at, process_state, pid, provider_session_id)
         VALUES ('interactive', 'pages', 'pi', 'm', 1, 1, ?, ?, ?, ?, 'prov') RETURNING id`,
      )
      .get(
        extra.closeRequestedAt ?? null,
        extra.closedAt ?? null,
        extra.pid === undefined ? 'stopped' : 'busy',
        extra.pid ?? null,
      ) as { id: number };
    return row.id;
  }

  const makeCopy = (s: ReturnType<typeof setup>, id: number) => {
    const copy = s.dataDir.chatWorkspacePath(id, s.deps.config.repositories.pages.folder);
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'work.txt'), 'x');
    return copy;
  };

  test('a turn running at restart is finalized interrupted and its session process group is killed and marked stopped', async () => {
    const s = setup();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    cleanups.push(() => child.kill('SIGKILL'));
    const sessionId = chat(s.db, { pid: child.pid! });
    const runId = insertRunning(s.db, null, s.clock.now(), child.pid!);
    s.db.prepare('UPDATE runs SET chat_session_id = ? WHERE id = ?').run(sessionId, runId);

    expect(await recoverInterruptedRuns(s.deps)).toBe(1);

    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(toRun(s.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId))).toMatchObject({
      status: 'finished',
      interrupted: 'worker-restart',
    });
    expect(
      s.db.prepare('SELECT process_state, pid, provider_session_id FROM chat_sessions WHERE id = ?').get(sessionId),
    ).toEqual({
      process_state: 'stopped',
      pid: null,
      provider_session_id: 'prov',
    });
  });

  test('an idle session process left behind is killed and marked stopped', async () => {
    const s = setup();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    cleanups.push(() => child.kill('SIGKILL'));
    const sessionId = chat(s.db, { pid: child.pid! });

    await recoverInterruptedRuns(s.deps);

    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(s.db.prepare('SELECT process_state, pid FROM chat_sessions WHERE id = ?').get(sessionId)).toEqual({
      process_state: 'stopped',
      pid: null,
    });
  });

  test('open Interactive Chat copies survive restart while closed, close-requested and orphan chat copies are deleted', async () => {
    const s = setup();
    const open = chat(s.db);
    const closed = chat(s.db, { closedAt: 5 });
    const closing = chat(s.db, { closeRequestedAt: 5 });
    const orphan = 9999;
    const copies = new Map([open, closed, closing, orphan].map((id) => [id, makeCopy(s, id)]));

    await recoverInterruptedRuns(s.deps);

    expect(fs.existsSync(copies.get(open)!)).toBe(true);
    expect(fs.existsSync(copies.get(closed)!)).toBe(false);
    expect(fs.existsSync(copies.get(closing)!)).toBe(false);
    expect(fs.existsSync(copies.get(orphan)!)).toBe(false);
  });

  test('per-Run copies are still cleared', async () => {
    const s = setup();
    const copy = s.dataDir.workspacePath(77, s.deps.config.repositories.pages.folder);
    fs.mkdirSync(copy, { recursive: true });
    const id = chat(s.db);
    makeCopy(s, id);

    await recoverInterruptedRuns(s.deps);

    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(s.dataDir.chatWorkspaceRoot(id))).toBe(true);
  });
});
