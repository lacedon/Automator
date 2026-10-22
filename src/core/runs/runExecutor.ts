import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toWatch } from '../db/rows';
import type { Clock, Interrupted, NeedsYouEvent, Outcome, Run, RunError, Trigger, Watch } from '../domain/types';
import { writeJsonAtomic, writeTextAtomic } from '../files/atomic';
import type { DataDir } from '../files/dataDir';
import { precheckFor, type Prechecks } from '../prechecks/index';
import type { Snapshot } from '../prechecks/types';
import type { CopilotExit, CopilotLauncher, RunningProcess } from './copilotLauncher';
import { applyOutcome, type RunFinal } from './outcomeApplier';
import { buildAdhocPrompt, buildWatchPrompt } from './promptBuilder';
import { closeWatch } from '../watches/needsYou';

const MAX_SUMMARY = 500;
const KILL_GRACE_MS = 10_000;
const RECENT_RUNS = 3;

export const copilotResultSchema = z.looseObject({
  outcome: z.enum(['nothing', 'acted', 'needs-you']),
  summary: z
    .string()
    .optional()
    .transform((s) => (s ?? '').slice(0, MAX_SUMMARY)),
});

export type ResultFileV1 = {
  schemaVersion: 1;
  runId: number;
  watchId: number | null;
  repository: string;
  trigger: Trigger;
  startedAt: string;
  endedAt: string;
  status: 'success' | 'error';
  outcome: Outcome | null;
  summary: string | null;
  error: RunError | null;
  exitCode: number | null;
  transcriptPath: string | null;
};

export interface RunExecutorDeps {
  db: Database;
  clock: Clock;
  config: Config;
  dataDir: DataDir;
  launcher: CopilotLauncher;
  prechecks: Prechecks;
  currentBranch?(cwd: string): Promise<string | null>;
  onNeedsYou(e: NeedsYouEvent): Promise<void>;
}

export type RunConclusion = Pick<RunFinal, 'exitCode' | 'resultStatus' | 'outcome' | 'summary' | 'error' | 'interrupted' | 'branch'>;

export function gitCurrentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

const failure = (code: string, message: string, extra: Partial<RunConclusion> = {}): RunConclusion => ({
  exitCode: null,
  resultStatus: 'error',
  outcome: null,
  summary: null,
  error: { code, message },
  interrupted: null,
  branch: null,
  ...extra,
});

const success = (outcome: Outcome, summary: string, exitCode: number | null): RunConclusion => ({
  exitCode,
  resultStatus: 'success',
  outcome,
  summary,
  error: null,
  interrupted: null,
  branch: null,
});

const existing = (file: string) => (fs.existsSync(file) ? file : null);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Shared by the executor and restart recovery: result.json, then OutcomeApplier, then the notifier.
function toFinal(deps: RunExecutorDeps, run: Run, conclusion: RunConclusion): RunFinal {
  const { dataDir } = deps;
  return {
    runId: run.id,
    endedAt: deps.clock.now(),
    ...conclusion,
    promptPath: existing(dataDir.promptPath(run.id)),
    transcriptPath: existing(dataDir.transcriptPath(run.id)),
    resultPath: dataDir.resultPath(run.id),
  };
}

async function notifyNeedsYou(deps: RunExecutorDeps, needsYou: NeedsYouEvent | null): Promise<void> {
  if (needsYou === null) return;
  try {
    await deps.onNeedsYou(needsYou);
  } catch {
    // Best effort: the event row keeps its pending Teams status.
  }
}

export async function finalizeRun(deps: RunExecutorDeps, run: Run, conclusion: RunConclusion): Promise<RunFinal> {
  const final = toFinal(deps, run, conclusion);
  const startedAt = run.startedAt ?? final.endedAt;
  const file: ResultFileV1 = {
    schemaVersion: 1,
    runId: run.id,
    watchId: run.watchId,
    repository: run.repository,
    trigger: run.trigger,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(final.endedAt).toISOString(),
    status: final.resultStatus,
    outcome: final.outcome,
    summary: final.summary,
    error: final.error,
    exitCode: final.exitCode,
    transcriptPath: final.transcriptPath,
  };
  writeJsonAtomic(final.resultPath, file);

  const { needsYou } = applyOutcome(deps.db, deps.config, final);
  await notifyNeedsYou(deps, needsYou);
  return final;
}

// Used when finalizeRun throws (disk full, SQLITE_BUSY, ...): a Run must never stay running, so record
// INTERNAL_ERROR in the DB only, through applyOutcome if possible, else with a bare guarded UPDATE.
async function finalizeAfterFailure(deps: RunExecutorDeps, run: Run, cause: unknown): Promise<RunFinal> {
  const final = toFinal(deps, run, failure('INTERNAL_ERROR', `Internal error: ${errorMessage(cause)}`));
  let needsYou: NeedsYouEvent | null = null;
  try {
    ({ needsYou } = applyOutcome(deps.db, deps.config, final));
  } catch (e) {
    console.error(`Run #${run.id}: applying the failure outcome failed: ${errorMessage(e)}`);
    deps.db
      .prepare(
        `UPDATE runs SET status = 'finished', ended_at = ?, result_status = 'error', error_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(final.endedAt, JSON.stringify(final.error), run.id);
  }
  await notifyNeedsYou(deps, needsYou);
  return final;
}

type Active = {
  run: Run;
  startedAt: number;
  proc: RunningProcess | null;
  exited: boolean;
  interrupted: Exclude<Interrupted, 'worker-restart'> | null;
  termSentAt: number | null;
  killSent: boolean;
};

export class RunExecutor {
  private active: Active | null = null;
  private readonly currentBranch: (cwd: string) => Promise<string | null>;

  constructor(private readonly deps: RunExecutorDeps) {
    this.currentBranch = deps.currentBranch ?? gitCurrentBranch;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  async execute(run: Run): Promise<RunFinal> {
    if (this.active !== null) throw new Error(`Run #${this.active.run.id} is already executing`);
    const active: Active = {
      run,
      startedAt: run.startedAt ?? this.deps.clock.now(),
      proc: null,
      exited: false,
      interrupted: null,
      termSentAt: null,
      killSent: false,
    };
    this.active = active;
    try {
      let conclusion: RunConclusion;
      try {
        conclusion = await this.conclude(active);
      } catch (e) {
        if (active.proc !== null && !active.exited) active.proc.kill('SIGKILL');
        conclusion = failure('INTERNAL_ERROR', `Internal error: ${errorMessage(e)}`);
      }
      try {
        return await finalizeRun(this.deps, run, conclusion);
      } catch (e) {
        console.error(`Run #${run.id}: finalizing failed: ${errorMessage(e)}`);
        return await finalizeAfterFailure(this.deps, run, e);
      }
    } finally {
      this.active = null;
    }
  }

  // Last resort when the worker is forced to exit: never leave Copilot running in the checkout.
  // If the worker exits before finalizing, restart recovery finalizes the Run as INTERRUPTED.
  killActive(): void {
    const a = this.active;
    if (a === null || a.proc === null || a.exited) return;
    a.proc.kill('SIGKILL');
  }

  watchdog(): void {
    const a = this.active;
    if (a === null || a.proc === null || a.exited) return;
    const now = this.deps.clock.now();
    const row = this.deps.db.prepare('SELECT cancel_requested_at FROM runs WHERE id = ?').get(a.run.id) as
      | { cancel_requested_at: number | null }
      | undefined;
    if (row?.cancel_requested_at != null) a.interrupted = 'cancelled';
    else if (a.interrupted === null && now - a.startedAt > this.deps.config.runs.timeoutMs) a.interrupted = 'timeout';
    if (a.interrupted === null) return;

    if (a.termSentAt === null) {
      a.termSentAt = now;
      a.proc.kill('SIGTERM');
    } else if (!a.killSent && now - a.termSentAt >= KILL_GRACE_MS) {
      a.killSent = true;
      a.proc.kill('SIGKILL');
    }
  }

  private async conclude(active: Active): Promise<RunConclusion> {
    const { db, config, dataDir, prechecks, launcher, clock } = this.deps;
    const { run } = active;
    dataDir.ensureRunDir(run.id);

    const repo = config.repositories[run.repository];
    if (repo === undefined) return failure('REPOSITORY_UNAVAILABLE', `Unknown Repository "${run.repository}"`);
    if (!fs.existsSync(repo.folder)) return failure('REPOSITORY_UNAVAILABLE', `Repository folder not found: ${repo.folder}`);

    const resultPath = dataDir.copilotResultPath(run.id);
    let prompt: string;
    if (run.watchId === null) {
      try {
        prompt = buildAdhocPrompt({ run, config, resultPath });
      } catch (e) {
        return failure('PROMPT_FAILED', errorMessage(e));
      }
    } else {
      const watchRow = db.prepare('SELECT * FROM watches WHERE id = ?').get(run.watchId);
      if (watchRow === undefined) return failure('PRECHECK_FAILED', `Watch #${run.watchId} not found`);
      const watch = toWatch(watchRow);
      if (watch.kind === 'jira' && !config.jira.enabled) {
        return failure('JIRA_DISABLED', 'Jira checking is off (jira.enabled is false)');
      }

      let snapshot: Snapshot;
      try {
        snapshot = await precheckFor(prechecks, watch.kind).snapshot(watch, { reviewUnresolved: run.reviewUnresolved });
      } catch (e) {
        return failure('PRECHECK_FAILED', errorMessage(e));
      }
      if (snapshot.close !== undefined) {
        closeWatch(db, watch.id, snapshot.close, clock.now());
        return success('nothing', `Closed: ${snapshot.close}`, null);
      }

      const updated = this.saveSnapshot(watch, run, snapshot);
      try {
        prompt = buildWatchPrompt({
          watch: updated,
          run,
          snapshot,
          recent: this.recentRuns(watch.id, run.id),
          config,
          resultPath,
          hasJiraToken: watch.kind === 'jira' && prechecks.jira.hasToken(watch),
        });
      } catch (e) {
        return failure('PROMPT_FAILED', errorMessage(e));
      }
    }

    const promptPath = dataDir.promptPath(run.id);
    writeTextAtomic(promptPath, prompt);
    db.prepare('UPDATE runs SET prompt_path = ? WHERE id = ?').run(promptPath, run.id);

    let started: RunningProcess | { spawnError: string };
    try {
      started = launcher.start({
        cwd: repo.folder,
        prompt,
        model: run.model,
        transcriptPath: dataDir.transcriptPath(run.id),
        logPath: dataDir.cliLogPath(run.id),
        env: process.env,
      });
    } catch (e) {
      started = { spawnError: errorMessage(e) };
    }

    let exit: CopilotExit;
    if ('spawnError' in started) {
      exit = { code: null, signal: null, spawnError: started.spawnError };
    } else {
      active.proc = started;
      if (started.pid > 0) db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(started.pid, run.id);
      exit = await started.exited;
      active.exited = true;
    }

    const branch = await this.currentBranch(repo.folder);
    return { ...this.evaluate(active, exit, resultPath), branch };
  }

  private evaluate(active: Active, exit: CopilotExit, resultPath: string): RunConclusion {
    const exitCode = exit.code;
    if (active.interrupted !== null) {
      const message =
        active.interrupted === 'cancelled'
          ? 'Run cancelled'
          : `Run timed out after ${Math.round((this.deps.config.runs.timeoutMs / 60_000) * 10) / 10} min`;
      return failure('INTERRUPTED', message, { exitCode, interrupted: active.interrupted });
    }
    if (exit.spawnError !== undefined) return failure('SPAWN_FAILED', exit.spawnError);
    if (exitCode !== 0) {
      const how = exitCode === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${exitCode}`;
      return failure('EXIT_NONZERO', `Copilot exited with ${how}`, { exitCode });
    }
    if (!fs.existsSync(resultPath)) return failure('RESULT_MISSING', 'Copilot did not write copilot-result.json', { exitCode });

    let parsed;
    try {
      parsed = copilotResultSchema.safeParse(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
    } catch (e) {
      return failure('RESULT_INVALID', `Invalid copilot-result.json: ${errorMessage(e)}`, { exitCode });
    }
    if (!parsed.success) {
      return failure('RESULT_INVALID', `Invalid copilot-result.json: ${z.prettifyError(parsed.error)}`, { exitCode });
    }
    return success(parsed.data.outcome, parsed.data.summary, exitCode);
  }

  private saveSnapshot(watch: Watch, run: Run, snapshot: Snapshot): Watch {
    const { db, clock } = this.deps;
    const mrSourceBranch = snapshot.sourceBranch ?? watch.mrSourceBranch;
    db.transaction(() => {
      db.prepare('UPDATE watches SET title = ?, mr_source_branch = ?, updated_at = ? WHERE id = ?').run(
        snapshot.title,
        mrSourceBranch,
        clock.now(),
        watch.id,
      );
      db.prepare('UPDATE runs SET cursor_candidate_json = ? WHERE id = ?').run(JSON.stringify(snapshot.cursorCandidate), run.id);
    })();
    return { ...watch, title: snapshot.title, mrSourceBranch };
  }

  private recentRuns(watchId: number, runId: number): Pick<Run, 'id' | 'outcome' | 'summary' | 'endedAt'>[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, outcome, summary, ended_at FROM runs
         WHERE watch_id = ? AND status = 'finished' AND id <> ?
         ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(watchId, runId, RECENT_RUNS) as { id: number; outcome: Outcome | null; summary: string | null; ended_at: number | null }[];
    return rows.map((r) => ({ id: r.id, outcome: r.outcome, summary: r.summary, endedAt: r.ended_at }));
  }
}
