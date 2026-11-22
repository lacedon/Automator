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
import { processLooksLikeSession, recoverInterruptedRuns } from './recovery';
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
    // The tests use `sleep` as the stand-in provider process.
    ownsSessionProcess: vi.fn(() => true),
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

  test('recovery turns an unpicked in-turn answer into one answer turn and expires unanswered questions', async () => {
    const s = setup();
    const sessionId = chat(s.db);
    const runId = insertRunning(s.db, null, s.clock.now());
    s.db.prepare('UPDATE runs SET chat_session_id = ? WHERE id = ?').run(sessionId, runId);
    const ask = s.db.prepare(
      `UPDATE chat_sessions SET question_text = 'Which?', question_options_json = '["A","B"]', question_source = 'automator',
         question_request_id = 'q', question_run_id = ?, question_asked_at = ?, question_expires_at = ?, question_answer = ? WHERE id = ?`,
    );
    ask.run(runId, s.clock.now(), s.clock.now() + 600_000, 'unpicked', sessionId);
    const other = chat(s.db);
    const finished = insertRunning(s.db, null, s.clock.now());
    s.db.prepare("UPDATE runs SET status = 'finished', chat_session_id = ? WHERE id = ?").run(other, finished);
    s.db
      .prepare(
        `UPDATE chat_sessions SET question_text = 'Later?', question_source = 'native', question_request_id = 'n', question_run_id = ?,
           question_asked_at = ?, question_expires_at = ?, question_expired_at = ? WHERE id = ?`,
      )
      .run(finished, 1, 2, 3, other);

    await recoverInterruptedRuns(s.deps);

    // The in-turn answer nobody picked up became exactly one answer turn on the Chat tip.
    expect(
      s.db
        .prepare('SELECT question_text, question_expired_at, question_answer FROM chat_sessions WHERE id = ?')
        .get(sessionId),
    ).toEqual({ question_text: null, question_expired_at: null, question_answer: null });
    expect(
      s.db.prepare("SELECT trigger, adhoc_prompt, parent_run_id FROM runs WHERE trigger = 'answer'").all(),
    ).toEqual([
      {
        trigger: 'answer',
        adhoc_prompt: 'Answer to your earlier question "Which?":\n\nunpicked',
        parent_run_id: runId,
      },
    ]);
    // An already expired question keeps its original expiry time.
    expect(s.db.prepare('SELECT question_expired_at FROM chat_sessions WHERE id = ?').get(other)).toEqual({
      question_expired_at: 3,
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

  test('a stored pid that now belongs to another process is left alone', async () => {
    const s = setup();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    cleanups.push(() => child.kill('SIGKILL'));
    const sessionId = chat(s.db, { pid: child.pid! });
    const runId = insertRunning(s.db, null, s.clock.now(), child.pid!);
    s.db.prepare('UPDATE runs SET chat_session_id = ? WHERE id = ?').run(sessionId, runId);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.deps.ownsSessionProcess = vi.fn(() => false);

    await recoverInterruptedRuns(s.deps);

    expect(s.deps.ownsSessionProcess).toHaveBeenCalledWith(child.pid, expect.arrayContaining(['pi']));
    expect(() => process.kill(child.pid!, 0)).not.toThrow(); // still running
    expect(s.db.prepare('SELECT process_state, pid FROM chat_sessions WHERE id = ?').get(sessionId)).toEqual({
      process_state: 'stopped',
      pid: null,
    });
    expect(toRun(s.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)).interrupted).toBe('worker-restart');
  });

  test('the default pid check recognises the provider executable and nothing else', async () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    cleanups.push(() => child.kill('SIGKILL'));
    expect(processLooksLikeSession(child.pid!, ['sleep'])).toBe(true);
    expect(processLooksLikeSession(child.pid!, ['claude-agent-acp', 'pi'])).toBe(false);
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(processLooksLikeSession(child.pid!, ['sleep'])).toBe(false);
  });

  test('incomplete copies left by a crash are removed and complete ones are kept', async () => {
    const s = setup();
    const id = chat(s.db);
    const copy = makeCopy(s, id);
    const partial = path.join(s.dataDir.chatWorkspaceRoot(id), '.copying-abc', 'repo');
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, 'half.txt'), 'x');

    await recoverInterruptedRuns(s.deps);

    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.existsSync(path.dirname(partial))).toBe(false);
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
