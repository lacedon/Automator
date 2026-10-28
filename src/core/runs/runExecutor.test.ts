import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig, type DeepPartial } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import { resolveSecrets } from '../config/load';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toRun, toWatch } from '../db/rows';
import type { NeedsYouEvent, Run, WatchKind } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { HttpError } from '../http/fetchWithRetry';
import { FreeformPrecheck } from '../prechecks/freeform';
import type { Prechecks } from '../prechecks/index';
import type { JiraPrecheck } from '../prechecks/jira';
import type { Precheck, Snapshot } from '../prechecks/types';
import { createCopilotLauncher, type CopilotExit, type CopilotLauncher, type RunningProcess } from './copilotLauncher';
import { copilotResultSchema, RunExecutor, type ResultFileV1 } from './runExecutor';

const FAKE = path.resolve('test/fixtures/fake-copilot.mjs');
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const candidate = { lastNoteId: 9, handledPipelineId: null, handledConflictSha: null };
const oldCursor = { lastNoteId: 1, handledPipelineId: null, handledConflictSha: null };

type SnapshotFn = () => Promise<Snapshot>;

type SetupOpts = {
  mode?: string;
  config?: DeepPartial<Config>;
  snapshot?: SnapshotFn;
  launcher?: CopilotLauncher;
  jiraHasToken?: boolean;
};

function setup(opts: SetupOpts = {}) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const config = testConfig({
    copilotBin: FAKE,
    prompts: { dir: path.resolve('prompts') },
    ...opts.config,
    runs: { timeoutMs: 1500, ...opts.config?.runs },
  });
  const secrets = resolveSecrets(config, {});
  const dataDir = new DataDir(config.dataDir);
  const real = createCopilotLauncher(config, secrets);
  const starts: Parameters<CopilotLauncher['start']>[0][] = [];
  const launcher: CopilotLauncher = opts.launcher ?? {
    start(o) {
      starts.push(o);
      return real.start({ ...o, env: { ...o.env, FAKE_COPILOT_MODE: opts.mode ?? 'nothing' } });
    },
  };
  const snapshot: SnapshotFn =
    opts.snapshot ??
    (async () => ({ events: [], cursorCandidate: candidate, title: 'New title', sourceBranch: 'feat/x' }));
  const stub: Precheck = { check: () => Promise.reject(new Error('not used')), snapshot };
  const prechecks: Prechecks = {
    mr: stub,
    jira: { ...stub, hasToken: () => opts.jiraHasToken ?? false } as unknown as JiraPrecheck,
    free: new FreeformPrecheck(),
  };
  const events: NeedsYouEvent[] = [];
  const onNeedsYou = vi.fn(async (e: NeedsYouEvent) => {
    events.push(e);
  });
  const currentBranch = vi.fn(async () => 'feat/x');
  const executor = new RunExecutor({
    db: t.db,
    clock,
    config,
    dataDir,
    launcher,
    prechecks,
    currentBranch,
    onNeedsYou,
  });
  return { db: t.db, clock, config, dataDir, executor, starts, events, onNeedsYou, currentBranch };
}

function addWatch(db: Database, kind: WatchKind = 'mr', repository = 'pages'): number {
  const id = insertWatch(db, { kind, repository });
  db.prepare('UPDATE watches SET cursor_json = ?, next_check_at = ? WHERE id = ?').run(
    JSON.stringify(oldCursor),
    1,
    id,
  );
  return id;
}

function claim(
  db: Database,
  startedAt: number,
  watchId: number | null,
  extra: { adhocPrompt?: string; repository?: string; parentRunId?: number } = {},
): Run {
  return toRun(
    db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, parent_run_id, model, queued_at, started_at)
         VALUES (?, ?, 'running', ?, ?, 'new comment', ?, ?, 'm1', ?, ?) RETURNING *`,
      )
      .get(
        watchId,
        extra.repository ?? 'pages',
        watchId === null ? 'adhoc' : 'schedule',
        watchId === null ? 0 : 1,
        extra.adhocPrompt ?? null,
        extra.parentRunId ?? null,
        startedAt,
        startedAt,
      ),
  );
}

const watchOf = (db: Database, id: number) => toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));
const runOf = (db: Database, id: number) => toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
const readResult = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as ResultFileV1;

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('copilotResultSchema', () => {
  test('requires a valid outcome', () => {
    expect(copilotResultSchema.safeParse({ outcome: 'maybe', summary: 's' }).success).toBe(false);
    expect(copilotResultSchema.safeParse({ summary: 's' }).success).toBe(false);
  });
});

describe('RunExecutor', () => {
  test('acted run writes result.json v1, transcript and advances cursor', async () => {
    const s = setup({ mode: 'acted' });
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    s.clock.advance(4000);

    const final = await s.executor.execute(run);

    expect(final).toMatchObject({ resultStatus: 'success', outcome: 'acted', summary: 'fake acted', exitCode: 0 });
    const result = readResult(s.dataDir.resultPath(run.id));
    expect(result).toEqual({
      schemaVersion: 1,
      runId: run.id,
      watchId,
      repository: 'pages',
      trigger: 'schedule',
      startedAt: new Date(run.startedAt!).toISOString(),
      endedAt: new Date(run.startedAt! + 4000).toISOString(),
      status: 'success',
      outcome: 'acted',
      summary: 'fake acted',
      error: null,
      exitCode: 0,
      transcriptPath: s.dataDir.transcriptPath(run.id),
    });
    expect(fs.readFileSync(s.dataDir.transcriptPath(run.id), 'utf8')).toContain('fake transcript');
    expect(fs.readFileSync(s.dataDir.promptPath(run.id), 'utf8')).toContain(s.dataDir.copilotResultPath(run.id));
    expect(s.starts[0]).toMatchObject({
      cwd: s.config.repositories.pages!.folder,
      model: 'm1',
      transcriptPath: s.dataDir.transcriptPath(run.id),
      logPath: s.dataDir.cliLogPath(run.id),
    });

    const row = runOf(s.db, run.id);
    expect(row).toMatchObject({
      status: 'finished',
      resultStatus: 'success',
      outcome: 'acted',
      cursorCandidate: candidate,
      promptPath: s.dataDir.promptPath(run.id),
      transcriptPath: s.dataDir.transcriptPath(run.id),
      resultPath: s.dataDir.resultPath(run.id),
    });
    expect(row.pid).toBeGreaterThan(0);
    const w = watchOf(s.db, watchId);
    expect(w).toMatchObject({ cursor: candidate, title: 'New title', mrSourceBranch: 'feat/x', state: 'active' });
    expect(s.executor.isBusy()).toBe(false);
  });

  test('needs-you outcome moves watch to needs_you and calls onNeedsYou once', async () => {
    const s = setup({ mode: 'needs-you' });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final).toMatchObject({ resultStatus: 'success', outcome: 'needs-you' });
    expect(watchOf(s.db, watchId)).toMatchObject({
      state: 'needs_you',
      needsYouReason: 'fake needs-you',
      cursor: oldCursor,
    });
    expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
    expect(s.events[0]).toMatchObject({ watchId, runId: final.runId });
  });

  test('onNeedsYou errors are ignored', async () => {
    const s = setup({ mode: 'needs-you' });
    s.onNeedsYou.mockRejectedValueOnce(new Error('teams down'));
    const watchId = addWatch(s.db);
    await expect(s.executor.execute(claim(s.db, s.clock.now(), watchId))).resolves.toMatchObject({
      outcome: 'needs-you',
    });
  });

  test.each([
    ['exit-1', 'EXIT_NONZERO', 'Copilot exited with code 1', 1],
    ['no-result', 'RESULT_MISSING', 'Copilot did not write copilot-result.json', 0],
    ['invalid-json', 'RESULT_INVALID', 'Invalid copilot-result.json: ', 0],
  ])('%s is %s error', async (mode, code, message, exitCode) => {
    const s = setup({ mode });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final).toMatchObject({ resultStatus: 'error', outcome: null, exitCode, interrupted: null });
    expect(final.error?.code).toBe(code);
    expect(final.error?.message.startsWith(message)).toBe(true);
    const result = readResult(final.resultPath);
    expect(result).toMatchObject({ status: 'error', outcome: null, error: final.error, exitCode });
    expect(result.transcriptPath).toBe(s.dataDir.transcriptPath(final.runId));
    expect(watchOf(s.db, watchId)).toMatchObject({
      state: 'needs_you',
      needsYouReason: final.error?.message,
      cursor: oldCursor,
    });
    expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
  });

  test('accepts long summary by truncating and ignores extra keys', async () => {
    const s = setup({ mode: 'long-summary' });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final).toMatchObject({ resultStatus: 'success', outcome: 'acted', summary: 'x'.repeat(500) });
    expect(readResult(final.resultPath)).not.toHaveProperty('extra');
    expect(watchOf(s.db, watchId).cursor).toEqual(candidate);
  });

  test('accepts a result without summary as empty summary', async () => {
    const s = setup({ mode: 'no-summary' });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final).toMatchObject({ resultStatus: 'success', outcome: 'acted', summary: '' });
    expect(watchOf(s.db, watchId).cursor).toEqual(candidate);
  });

  test('internal error after the run finalizes as INTERNAL_ERROR and moves watch to needs_you', async () => {
    const s = setup({ mode: 'acted' });
    s.currentBranch.mockRejectedValueOnce(new Error('git exploded'));
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    const final = await s.executor.execute(run);
    expect(final).toMatchObject({
      resultStatus: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'Internal error: git exploded' },
    });
    expect(runOf(s.db, run.id)).toMatchObject({ status: 'finished', error: final.error });
    expect(readResult(final.resultPath).error).toEqual(final.error);
    expect(watchOf(s.db, watchId).state).toBe('needs_you');
    expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
    expect(s.executor.isBusy()).toBe(false);
  });

  describe('finalize failure never leaves the run running', () => {
    const silenceErrors = () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      cleanups.push(() => spy.mockRestore());
      return spy;
    };

    test('result.json write failure finalizes in the DB as INTERNAL_ERROR and moves watch to needs_you', async () => {
      const logged = silenceErrors();
      const s = setup({ mode: 'acted' });
      const watchId = addWatch(s.db);
      const run = claim(s.db, s.clock.now(), watchId);
      fs.mkdirSync(path.join(s.dataDir.resultPath(run.id), 'blocker'), { recursive: true });

      const final = await s.executor.execute(run);

      expect(final.error?.code).toBe('INTERNAL_ERROR');
      expect(final.error?.message).toMatch(/^Internal error: /);
      expect(runOf(s.db, run.id)).toMatchObject({ status: 'finished', resultStatus: 'error', error: final.error });
      expect(watchOf(s.db, watchId)).toMatchObject({ state: 'needs_you', needsYouRunId: run.id, cursor: oldCursor });
      expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
      expect(s.executor.isBusy()).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`Run #${run.id}: finalizing failed`));
    });

    test('applyOutcome failure falls back to an INTERNAL_ERROR outcome', async () => {
      silenceErrors();
      const s = setup({ mode: 'acted' });
      s.db.exec(
        "CREATE TRIGGER no_success BEFORE UPDATE OF status ON runs WHEN NEW.result_status = 'success' BEGIN SELECT RAISE(ABORT, 'db is busy'); END",
      );
      const watchId = addWatch(s.db);
      const run = claim(s.db, s.clock.now(), watchId);

      const final = await s.executor.execute(run);

      expect(final.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error: db is busy' });
      expect(runOf(s.db, run.id)).toMatchObject({ status: 'finished', resultStatus: 'error', error: final.error });
      expect(watchOf(s.db, watchId).state).toBe('needs_you');
      expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
      expect(s.executor.isBusy()).toBe(false);
    });

    test('when applyOutcome keeps failing, a guarded UPDATE still finishes the run', async () => {
      const logged = silenceErrors();
      const s = setup({ mode: 'acted' });
      const watchId = addWatch(s.db);
      s.db.exec(
        "CREATE TRIGGER no_watch_update BEFORE UPDATE ON watches BEGIN SELECT RAISE(ABORT, 'watch locked'); END",
      );
      const run = claim(s.db, s.clock.now(), watchId);

      const final = await s.executor.execute(run);

      expect(final.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error: watch locked' });
      expect(runOf(s.db, run.id)).toMatchObject({ status: 'finished', resultStatus: 'error', error: final.error });
      expect(watchOf(s.db, watchId).state).toBe('active');
      expect(s.onNeedsYou).not.toHaveBeenCalled();
      expect(s.executor.isBusy()).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('applying the failure outcome failed: watch locked'));
    });
  });

  test('db failure storing pid kills the started process and is INTERNAL_ERROR, not SPAWN_FAILED', async () => {
    const kills: string[] = [];
    const proc: RunningProcess = { pid: 4321, exited: new Promise(() => {}), kill: (sig) => kills.push(sig) };
    const s = setup({ launcher: { start: () => proc } });
    s.db.exec("CREATE TRIGGER no_pid BEFORE UPDATE OF pid ON runs BEGIN SELECT RAISE(ABORT, 'pid write failed'); END");
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error: pid write failed' });
    expect(kills).toEqual(['SIGKILL']);
    expect(runOf(s.db, final.runId).status).toBe('finished');
  });

  test('timeout kills process and records interrupted timeout', async () => {
    const s = setup({ mode: 'hang' });
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    const pending = s.executor.execute(run);
    await waitFor(() => runOf(s.db, run.id).pid !== null);
    expect(s.executor.isBusy()).toBe(true);

    s.clock.advance(1500);
    s.executor.watchdog();
    expect(runOf(s.db, run.id).status).toBe('running');
    s.clock.advance(1);
    s.executor.watchdog();

    const final = await pending;
    expect(final).toMatchObject({
      resultStatus: 'error',
      interrupted: 'timeout',
      error: { code: 'INTERRUPTED', message: 'Run timed out after 0 min' },
    });
    expect(runOf(s.db, run.id)).toMatchObject({ status: 'finished', interrupted: 'timeout' });
    expect(watchOf(s.db, watchId).state).toBe('needs_you');
    expect(s.executor.isBusy()).toBe(false);
  });

  test('killActive SIGKILLs the running copilot process group', async () => {
    const s = setup({ mode: 'hang' });
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    const pending = s.executor.execute(run);
    await waitFor(() => runOf(s.db, run.id).pid !== null);
    const { pid } = runOf(s.db, run.id);

    s.executor.killActive();

    const final = await pending;
    expect(final.exitCode).toBeNull();
    expect(() => process.kill(-pid!, 0)).toThrow();
    s.executor.killActive();
  });

  test('cancel request kills process and records interrupted cancelled', async () => {
    const s = setup({ mode: 'hang' });
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    const pending = s.executor.execute(run);
    await waitFor(() => runOf(s.db, run.id).pid !== null);

    s.executor.watchdog();
    s.db.prepare('UPDATE runs SET cancel_requested_at = ? WHERE id = ?').run(s.clock.now(), run.id);
    s.clock.advance(5000);
    s.executor.watchdog();

    const final = await pending;
    expect(final).toMatchObject({ interrupted: 'cancelled', error: { code: 'INTERRUPTED', message: 'Run cancelled' } });
    expect(readResult(final.resultPath).error).toEqual({ code: 'INTERRUPTED', message: 'Run cancelled' });
  });

  test('cancel requested before copilot starts never spawns it and finishes as cancelled', async () => {
    let runId = 0;
    const s = setup({
      snapshot: async () => {
        s.db.prepare('UPDATE runs SET cancel_requested_at = ? WHERE id = ?').run(s.clock.now(), runId);
        return { events: [], cursorCandidate: candidate, title: 'New title', sourceBranch: 'feat/x' };
      },
    });
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    runId = run.id;

    const final = await s.executor.execute(run);

    expect(s.starts).toHaveLength(0);
    expect(final).toMatchObject({ interrupted: 'cancelled', error: { code: 'INTERRUPTED', message: 'Run cancelled' } });
    expect(runOf(s.db, run.id)).toMatchObject({ status: 'finished', interrupted: 'cancelled', pid: null });
    expect(watchOf(s.db, watchId).cursor).toEqual(oldCursor);
  });

  test('watchdog sends SIGTERM once, prefers cancel, and SIGKILL 10 s later', async () => {
    const kills: string[] = [];
    let exit!: (e: CopilotExit) => void;
    const proc: RunningProcess = {
      pid: 99999,
      exited: new Promise((r) => (exit = r)),
      kill: (sig) => kills.push(sig),
    };
    const s = setup({ launcher: { start: () => proc } });
    const watchId = addWatch(s.db);
    const run = claim(s.db, s.clock.now(), watchId);
    const pending = s.executor.execute(run);
    await waitFor(() => runOf(s.db, run.id).pid !== null);

    s.clock.advance(1501);
    s.db.prepare('UPDATE runs SET cancel_requested_at = ? WHERE id = ?').run(s.clock.now(), run.id);
    s.executor.watchdog();
    s.executor.watchdog();
    expect(kills).toEqual(['SIGTERM']);
    s.clock.advance(9999);
    s.executor.watchdog();
    expect(kills).toEqual(['SIGTERM']);
    s.clock.advance(1);
    s.executor.watchdog();
    s.executor.watchdog();
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);

    exit({ code: null, signal: 'SIGKILL' });
    expect(await pending).toMatchObject({ interrupted: 'cancelled', exitCode: null, error: { code: 'INTERRUPTED' } });
  });

  test('missing repository folder fails preflight without transcript', async () => {
    const s = setup();
    const watchId = addWatch(s.db);
    fs.rmSync(s.config.repositories.pages!.folder, { recursive: true });
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.error).toEqual({
      code: 'REPOSITORY_UNAVAILABLE',
      message: `Repository folder not found: ${s.config.repositories.pages!.folder}`,
    });
    expect(final).toMatchObject({ transcriptPath: null, promptPath: null, branch: null, exitCode: null });
    expect(readResult(final.resultPath).transcriptPath).toBeNull();
    expect(s.starts).toHaveLength(0);
    expect(watchOf(s.db, watchId).state).toBe('needs_you');
  });

  test('unknown repository fails preflight', async () => {
    const s = setup();
    const watchId = addWatch(s.db, 'mr', 'ghost');
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId, { repository: 'ghost' }));
    expect(final.error).toEqual({ code: 'REPOSITORY_UNAVAILABLE', message: 'Unknown Repository "ghost"' });
  });

  test('jira disabled fails preflight with JIRA_DISABLED', async () => {
    const s = setup();
    const watchId = addWatch(s.db, 'jira');
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.error).toEqual({ code: 'JIRA_DISABLED', message: 'Jira checking is off (jira.enabled is false)' });
    expect(s.starts).toHaveLength(0);
  });

  test('jira run passes hasJiraToken to the prompt', async () => {
    const s = setup({ config: { jira: { enabled: true } }, jiraHasToken: false });
    const watchId = addWatch(s.db, 'jira');
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.resultStatus).toBe('success');
    expect(fs.readFileSync(s.dataDir.promptPath(final.runId), 'utf8')).toContain('No Jira REST token is configured');
  });

  test.each([
    ['http', new HttpError('GitLab returned 500', 500, false)],
    ['syntax', new SyntaxError('Unexpected token')],
  ])('snapshot failure is PRECHECK_FAILED (%s)', async (_name, error) => {
    const s = setup({ snapshot: () => Promise.reject(error) });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.error).toEqual({ code: 'PRECHECK_FAILED', message: error.message });
    expect(final.transcriptPath).toBeNull();
    expect(s.starts).toHaveLength(0);
  });

  test("snapshot reporting merged closes watch and finishes success nothing 'Closed: merged' without Copilot", async () => {
    const s = setup({
      snapshot: async () => ({ events: [], cursorCandidate: candidate, title: 't', close: 'merged' }),
    });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final).toMatchObject({
      resultStatus: 'success',
      outcome: 'nothing',
      summary: 'Closed: merged',
      transcriptPath: null,
    });
    expect(watchOf(s.db, watchId)).toMatchObject({ state: 'closed', closedReason: 'merged' });
    expect(s.starts).toHaveLength(0);
    expect(s.onNeedsYou).not.toHaveBeenCalled();
    expect(readResult(final.resultPath)).toMatchObject({
      status: 'success',
      outcome: 'nothing',
      summary: 'Closed: merged',
    });
  });

  test('missing default prompt file is PROMPT_FAILED', async () => {
    const s = setup({ config: { prompts: { dir: '/nonexistent/prompts' } } });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.error?.code).toBe('PROMPT_FAILED');
    expect(final.error?.message).toContain('/nonexistent/prompts/mr.md');
    expect(final).toMatchObject({ promptPath: null, transcriptPath: null });
    expect(s.starts).toHaveLength(0);
  });

  test('spawn failure becomes SPAWN_FAILED error result', async () => {
    const s = setup({ config: { copilotBin: '/nonexistent/copilot' } });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final).toMatchObject({ resultStatus: 'error', exitCode: null, transcriptPath: null });
    expect(final.error?.code).toBe('SPAWN_FAILED');
    expect(final.error?.message).toContain('ENOENT');
    expect(final.promptPath).toBe(s.dataDir.promptPath(final.runId));
    expect(watchOf(s.db, watchId).state).toBe('needs_you');
    expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
  });

  test('synchronous launcher throw becomes SPAWN_FAILED', async () => {
    const s = setup({
      launcher: {
        start: () => {
          throw new Error('bad arg');
        },
      },
    });
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.error).toEqual({ code: 'SPAWN_FAILED', message: 'bad arg' });
  });

  test('adhoc run uses adhoc prompt and leaves watches untouched', async () => {
    const s = setup({ mode: 'needs-you' });
    const watchId = addWatch(s.db);
    const before = watchOf(s.db, watchId);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), null, { adhocPrompt: 'Bump the version' }));
    expect(final).toMatchObject({ resultStatus: 'success', outcome: 'needs-you' });
    const prompt = fs.readFileSync(s.dataDir.promptPath(final.runId), 'utf8');
    expect(prompt).toContain('Bump the version');
    expect(prompt).not.toContain('## Watch');
    expect(watchOf(s.db, watchId)).toEqual(before);
    expect(s.onNeedsYou).not.toHaveBeenCalled();
    expect(readResult(final.resultPath)).toMatchObject({ watchId: null, trigger: 'adhoc' });
    expect(runOf(s.db, final.runId).cursorCandidate).toBeNull();
  });

  describe('Copilot sessions', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const finishedParent = (db: Database, sessionId: string | null): number =>
      (
        db
          .prepare(
            `INSERT INTO runs (repository, status, trigger, priority, reason, adhoc_prompt, model, queued_at, ended_at, session_id)
             VALUES ('pages', 'finished', 'adhoc', 0, 'r', 'first', 'm', 1, 2, ?) RETURNING id`,
          )
          .get(sessionId) as { id: number }
      ).id;

    test('ad-hoc Run gets a generated session id, saved before Copilot exits', async () => {
      const s = setup({ mode: 'hang' });
      const run = claim(s.db, s.clock.now(), null, { adhocPrompt: 'Do it' });
      const done = s.executor.execute(run);
      await waitFor(() => s.starts.length === 1);
      const sessionId = s.starts[0].sessionId;
      expect(sessionId).toMatch(UUID);
      expect(runOf(s.db, run.id).sessionId).toBe(sessionId);
      s.executor.killActive();
      await done;
    });

    test("follow-up Run reuses the parent's session id", async () => {
      const s = setup();
      const parentRunId = finishedParent(s.db, 'parent-session');
      const run = claim(s.db, s.clock.now(), null, { adhocPrompt: 'More', parentRunId });
      await s.executor.execute(run);
      expect(s.starts[0].sessionId).toBe('parent-session');
      expect(runOf(s.db, run.id).sessionId).toBe('parent-session');
    });

    test('follow-up Run fails with SESSION_RESUME_FAILED when the parent has no session', async () => {
      const s = setup();
      const parentRunId = finishedParent(s.db, null);
      const final = await s.executor.execute(claim(s.db, s.clock.now(), null, { adhocPrompt: 'More', parentRunId }));
      expect(final.error?.code).toBe('SESSION_RESUME_FAILED');
      expect(s.starts).toHaveLength(0);
    });

    test('Watch Run passes no session id', async () => {
      const s = setup();
      const watchId = addWatch(s.db);
      const run = claim(s.db, s.clock.now(), watchId);
      await s.executor.execute(run);
      expect(s.starts[0].sessionId).toBeUndefined();
      expect(runOf(s.db, run.id).sessionId).toBeNull();
    });
  });

  test('includes the last 3 finished runs of the watch in the prompt', async () => {
    const s = setup();
    const watchId = addWatch(s.db);
    const insert = s.db.prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at, ended_at, outcome, summary)
       VALUES (?, 'pages', 'finished', 'schedule', 1, 'r', 'm', 1, ?, 'acted', ?)`,
    );
    for (const n of [1, 2, 3, 4]) insert.run(watchId, n * 1000, `old run ${n}`);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    const prompt = fs.readFileSync(s.dataDir.promptPath(final.runId), 'utf8');
    expect(prompt).toContain('old run 4');
    expect(prompt).toContain('old run 2');
    expect(prompt).not.toContain('old run 1');
  });

  test('stores branch from currentBranch', async () => {
    const s = setup();
    s.currentBranch.mockResolvedValueOnce('feature/branch-after');
    const watchId = addWatch(s.db);
    const final = await s.executor.execute(claim(s.db, s.clock.now(), watchId));
    expect(final.branch).toBe('feature/branch-after');
    expect(runOf(s.db, final.runId).branch).toBe('feature/branch-after');
    expect(s.currentBranch).toHaveBeenCalledWith(s.config.repositories.pages!.folder);
  });
});
