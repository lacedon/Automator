import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeClock } from '../../../test/helpers/clock';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
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
    clock,
    config,
    dataDir,
    launcher,
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
    const result = JSON.parse(fs.readFileSync(s.dataDir.resultPath(runId), 'utf8')) as ResultFileV1;
    expect(result).toMatchObject({ schemaVersion: 1, runId, status: 'error', outcome: null, error: run.error });
    expect(toWatch(s.db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId))).toMatchObject({
      state: 'needs_you',
      needsYouRunId: runId,
    });
    expect(s.onNeedsYou).toHaveBeenCalledTimes(1);
    expect(await recoverInterruptedRuns(s.deps)).toBe(0);
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
