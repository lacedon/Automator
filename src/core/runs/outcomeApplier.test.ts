import { afterEach, describe, expect, it, test } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import type { Database } from '../db/open';
import { toRun, toWatch } from '../db/rows';
import type { WatchState } from '../domain/types';
import { applyOutcome, type RunFinal } from './outcomeApplier';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const t = tempDb();
  cleanups.push(t.cleanup);
  return t.db;
}

const startedAt = Date.parse('2026-10-21T11:00:00');
const endedAt = Date.parse('2026-10-21T11:05:00');
const oldCursor = { lastNoteId: 1, handledPipelineId: null, handledConflictSha: null };
const candidate = { lastNoteId: 9, handledPipelineId: 5, handledConflictSha: null };

function insertRunningRun(db: Database, watchId: number | null, cursorCandidate: unknown = candidate): number {
  const info = db
    .prepare(
      `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at, started_at, pid,
                         cursor_candidate_json)
       VALUES (?, 'pages', 'running', ?, 1, 'r', 'm', ?, ?, 4242, ?)`,
    )
    .run(
      watchId,
      watchId === null ? 'adhoc' : 'schedule',
      startedAt,
      startedAt,
      cursorCandidate === null ? null : JSON.stringify(cursorCandidate),
    );
  return Number(info.lastInsertRowid);
}

function prepareWatch(db: Database, state: WatchState): number {
  const id = insertWatch(db, { state, kind: 'mr' });
  db.prepare('UPDATE watches SET cursor_json = ?, resolution_note = ?, next_check_at = ? WHERE id = ?').run(
    JSON.stringify(oldCursor),
    'fixed it',
    state === 'active' ? startedAt : null,
    id,
  );
  return id;
}

function watch(db: Database, id: number) {
  return toWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));
}

function run(db: Database, id: number) {
  return toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

function eventCount(db: Database): number {
  return (db.prepare('SELECT count(*) AS n FROM needs_you_events').get() as { n: number }).n;
}

function final(runId: number, overrides: Partial<RunFinal> = {}): RunFinal {
  return {
    runId,
    endedAt,
    exitCode: 0,
    resultStatus: 'success',
    outcome: 'nothing',
    summary: 'All quiet.',
    error: null,
    interrupted: null,
    branch: 'feature/x',
    promptPath: '/data/runs/1/prompt.md',
    transcriptPath: '/data/runs/1/transcript.md',
    resultPath: '/data/runs/1/result.json',
    ...overrides,
  };
}

type ResultKind = 'nothing' | 'acted' | 'needs-you' | 'error';

function resultOverrides(kind: ResultKind): Partial<RunFinal> {
  if (kind === 'error') {
    return {
      resultStatus: 'error',
      outcome: null,
      summary: null,
      exitCode: 1,
      error: { code: 'EXIT_NONZERO', message: 'copilot exited with 1' },
    };
  }
  if (kind === 'needs-you') return { outcome: 'needs-you', summary: 'Need a decision on API shape.' };
  return { outcome: kind, summary: `did ${kind}` };
}

const states: WatchState[] = ['active', 'paused', 'closed'];
const results: ResultKind[] = ['nothing', 'acted', 'needs-you', 'error'];
const matrix = states.flatMap((state) => results.map((result) => [state, result] as const));

describe('applyOutcome', () => {
  it.each(matrix)('%s watch with %s result', (state, result) => {
    const db = setup();
    const config = testConfig({ teams: { chatId: 'chat-1' } });
    const watchId = prepareWatch(db, state);
    const before = watch(db, watchId);
    const runId = insertRunningRun(db, watchId);

    const out = applyOutcome(db, config, final(runId, resultOverrides(result)));
    const after = watch(db, watchId);

    if (state === 'closed') {
      expect(out.needsYou).toBeNull();
      expect(after.state).toBe('closed');
      expect(eventCount(db)).toBe(0);
    }

    if (result === 'nothing' || result === 'acted') {
      expect(out.needsYou).toBeNull();
      expect(after.cursor).toEqual(candidate);
      expect(after.resolutionNote).toBeNull();
      expect(after.state).toBe(state);
      expect(after.nextCheckAt).toBe(state === 'active' ? endedAt + config.schedule.intervals.mr : before.nextCheckAt);
      expect(after.updatedAt).toBe(endedAt);
      expect(eventCount(db)).toBe(0);
    } else {
      expect(after.cursor).toEqual(oldCursor);
      expect(after.resolutionNote).toBe('fixed it');
      if (state !== 'closed') {
        const reason = result === 'error' ? 'copilot exited with 1' : 'Need a decision on API shape.';
        expect(after).toMatchObject({
          state: 'needs_you',
          needsYouReason: reason,
          needsYouSince: endedAt,
          needsYouRunId: runId,
          nextCheckAt: null,
          updatedAt: endedAt,
        });
        expect(out.needsYou).toMatchObject({ watchId, runId, reason, createdAt: endedAt, teamsStatus: 'pending' });
        expect(eventCount(db)).toBe(1);
      }
    }
  });

  test('needs-you event is disabled without teams config', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const runId = insertRunningRun(db, watchId);
    const out = applyOutcome(db, testConfig(), final(runId, resultOverrides('needs-you')));
    expect(out.needsYou?.teamsStatus).toBe('disabled');
  });

  test('falls back to default reasons when summary or error is missing', () => {
    const db = setup();
    const a = prepareWatch(db, 'active');
    const b = prepareWatch(db, 'active');
    const runA = insertRunningRun(db, a);
    applyOutcome(db, testConfig(), final(runA, { outcome: 'needs-you', summary: null }));
    const runB = insertRunningRun(db, b);
    applyOutcome(db, testConfig(), final(runB, { resultStatus: 'error', outcome: null, error: null }));
    expect(watch(db, a).needsYouReason).toBe('Copilot asked for help');
    expect(watch(db, b).needsYouReason).toBe('Run failed');
  });

  test('keeps existing cursor when the run has no cursor candidate', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const runId = insertRunningRun(db, watchId, null);
    applyOutcome(db, testConfig(), final(runId, resultOverrides('acted')));
    expect(watch(db, watchId).cursor).toEqual(oldCursor);
  });

  test('uses the watch interval override for next check', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    db.prepare('UPDATE watches SET interval_ms = 60000 WHERE id = ?').run(watchId);
    const runId = insertRunningRun(db, watchId);
    applyOutcome(db, testConfig(), final(runId));
    expect(watch(db, watchId).nextCheckAt).toBe(endedAt + 60000);
  });

  test('adhoc runs never touch watches', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const before = watch(db, watchId);
    const runId = insertRunningRun(db, null);
    for (const kind of results) {
      expect(applyOutcome(db, testConfig({ teams: { chatId: 'c' } }), final(runId, resultOverrides(kind)))).toEqual({
        needsYou: null,
      });
    }
    expect(watch(db, watchId)).toEqual(before);
    expect(eventCount(db)).toBe(0);
    expect(run(db, runId).status).toBe('finished');
  });

  test('finalizes only the run row when its watch was deleted', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const runId = insertRunningRun(db, watchId);
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM watches WHERE id = ?').run(watchId);
    db.pragma('foreign_keys = ON');
    const out = applyOutcome(db, testConfig(), final(runId, resultOverrides('needs-you')));
    expect(out).toEqual({ needsYou: null });
    expect(run(db, runId).status).toBe('finished');
    expect(eventCount(db)).toBe(0);
  });

  test('second finalize of the same run changes nothing', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const runId = insertRunningRun(db, watchId);
    const config = testConfig({ teams: { chatId: 'c' } });
    expect(applyOutcome(db, config, final(runId, resultOverrides('error'))).needsYou).not.toBeNull();
    const runBefore = run(db, runId);
    const watchBefore = watch(db, watchId);

    const out = applyOutcome(db, config, final(runId, { ...resultOverrides('needs-you'), endedAt: endedAt + 1 }));

    expect(out).toEqual({ needsYou: null });
    expect(run(db, runId)).toEqual(runBefore);
    expect(watch(db, watchId)).toEqual(watchBefore);
    expect(eventCount(db)).toBe(1);
  });

  test('throws for an unknown run id', () => {
    const db = setup();
    expect(() => applyOutcome(db, testConfig(), final(404))).toThrow('Run #404 not found');
  });

  test('success without an outcome is not treated as success', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const runId = insertRunningRun(db, watchId);
    const out = applyOutcome(db, testConfig(), final(runId, { outcome: null, summary: null }));
    expect(out.needsYou).not.toBeNull();
    expect(watch(db, watchId)).toMatchObject({ state: 'needs_you', cursor: oldCursor });
  });

  test('run row finalized with all fields', () => {
    const db = setup();
    const watchId = prepareWatch(db, 'active');
    const runId = insertRunningRun(db, watchId);
    const error = { code: 'TIMEOUT', message: 'Run timed out', detail: { minutes: 30 } };
    applyOutcome(
      db,
      testConfig(),
      final(runId, {
        resultStatus: 'error',
        outcome: null,
        summary: 'partial',
        exitCode: null,
        error,
        interrupted: 'timeout',
      }),
    );
    expect(run(db, runId)).toMatchObject({
      status: 'finished',
      startedAt,
      endedAt,
      exitCode: null,
      resultStatus: 'error',
      outcome: null,
      summary: 'partial',
      error,
      interrupted: 'timeout',
      cursorCandidate: candidate,
      branch: 'feature/x',
      promptPath: '/data/runs/1/prompt.md',
      transcriptPath: '/data/runs/1/transcript.md',
      resultPath: '/data/runs/1/result.json',
    });

    const okId = insertRunningRun(db, watchId);
    applyOutcome(db, testConfig(), final(okId, resultOverrides('acted')));
    expect(run(db, okId)).toMatchObject({
      status: 'finished',
      endedAt,
      exitCode: 0,
      resultStatus: 'success',
      outcome: 'acted',
      summary: 'did acted',
      error: null,
      interrupted: null,
    });
  });
});
