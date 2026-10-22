import fs from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core, type GitLabClient } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';
import { insertWatch } from '../../test/helpers/db';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
);
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ redirect }));

const { pauseWatch, closeWatch, reopenWatch, deleteWatch, runWatchNow, createWatch, updateWatch, previewTarget } =
  await import('./watches');

const MR_URL = 'https://gitlab.example.com/team/app/-/merge_requests/42';
const mrLookup = vi.fn<GitLabClient['mr']>();

let core: Core;

beforeEach(() => {
  mrLookup.mockReset();
  core = createCore(testConfig(), {
    clock: fakeClock(),
    notifier: { async notifyNeedsYou() {} },
    gitlab: () => ({ mr: mrLookup }) as unknown as GitLabClient,
  });
  holder.core = core;
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterEach(() => core.close());

const stateOf = (id: number) => core.watches.get(id)?.state;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

type QueuedRun = { watchId: number; trigger: string; extraInstructions: string | null; reviewUnresolved: number };

function queued(): QueuedRun[] {
  return core.db
    .prepare(
      `SELECT watch_id AS watchId, trigger, extra_instructions AS extraInstructions, review_unresolved AS reviewUnresolved
       FROM runs WHERE status = 'queued'`,
    )
    .all() as QueuedRun[];
}

test('pauseWatch pauses an active Watch and revalidates the layout', async () => {
  const id = insertWatch(core.db);
  expect(await pauseWatch(id)).toEqual({ ok: true });
  expect(stateOf(id)).toBe('paused');
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('pauseWatch returns domain errors instead of throwing', async () => {
  const closed = insertWatch(core.db, { state: 'closed' });
  expect(await pauseWatch(closed)).toEqual({
    ok: false,
    error: { code: 'INVALID_STATE', state: 'closed', action: 'pause' },
  });
  expect(await pauseWatch(99_999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await pauseWatch(-1)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});

test('closeWatch closes and reopenWatch reopens', async () => {
  const id = insertWatch(core.db);
  expect(await closeWatch(id)).toEqual({ ok: true });
  expect(stateOf(id)).toBe('closed');
  expect(await reopenWatch(id)).toEqual({ ok: true });
  expect(stateOf(id)).toBe('active');
  expect(revalidatePath).toHaveBeenCalledTimes(2);
});

test('reopenWatch reports a duplicate open Watch', async () => {
  const closed = insertWatch(core.db, { state: 'closed', normalizedTarget: 'gitlab:x!1' });
  insertWatch(core.db, { normalizedTarget: 'gitlab:x!1' });
  expect(await reopenWatch(closed)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_WATCH' } });
});

test('deleteWatch deletes and redirects to /watches', async () => {
  const id = insertWatch(core.db);
  await expect(deleteWatch(id)).rejects.toThrow('NEXT_REDIRECT /watches');
  expect(core.watches.get(id)).toBeNull();
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  expect(redirect).toHaveBeenCalledWith('/watches');
});

test('deleteWatch refuses while a Run is in progress', async () => {
  const id = insertWatch(core.db);
  const run = core.watches.runNow(id, {});
  if (!run.ok) throw new Error('enqueue failed');
  core.db.prepare("UPDATE runs SET status = 'running', started_at = 1 WHERE id = ?").run(run.value.id);
  expect(await deleteWatch(id)).toEqual({ ok: false, error: { code: 'RUN_IN_PROGRESS', runId: run.value.id } });
  expect(redirect).not.toHaveBeenCalled();
});

test('runWatchNow queues a manual Run with extra instructions and the review flag', async () => {
  const id = insertWatch(core.db);
  const result = await runWatchNow(
    null,
    form({ id: String(id), extraInstructions: 'Be brief', reviewUnresolved: 'on' }),
  );
  expect(result).toMatchObject({ ok: true });
  const [run] = queued();
  expect(run).toMatchObject({ watchId: id, trigger: 'manual', extraInstructions: 'Be brief', reviewUnresolved: 1 });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('runWatchNow treats blank instructions and a missing checkbox as not set', async () => {
  const id = insertWatch(core.db);
  expect(await runWatchNow(null, form({ id: String(id), extraInstructions: '  ' }))).toMatchObject({ ok: true });
  expect(queued()[0]).toMatchObject({ extraInstructions: null, reviewUnresolved: 0 });
});

test('runWatchNow returns JIRA_DISABLED for Jira Watches when Jira is off', async () => {
  const id = insertWatch(core.db, { kind: 'jira', normalizedTarget: 'jira:PROJ-1' });
  expect(await runWatchNow(null, form({ id: String(id) }))).toEqual({ ok: false, error: { code: 'JIRA_DISABLED' } });
  expect(queued()).toEqual([]);
});

const watchFields = {
  target: MR_URL,
  repository: 'pages',
  instructions: 'Keep it short',
  interval: '30m',
  model: '',
  initialReview: '',
};

test('createWatch creates the Watch, revalidates and redirects to it', async () => {
  await expect(createWatch(null, form(watchFields))).rejects.toThrow(/NEXT_REDIRECT \/watches\/\d+/);
  const [watch] = core.watches.list();
  expect(watch).toMatchObject({
    kind: 'mr',
    repository: 'pages',
    instructions: 'Keep it short',
    intervalMs: 30 * 60_000,
    model: null,
  });
  expect(watch!.initialReview).toBeNull();
  expect(redirect).toHaveBeenCalledWith(`/watches/${watch!.id}`);
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('createWatch keeps the default interval when the field is missing or blank and stores explicit choices', async () => {
  const withoutInterval = form({ ...watchFields, model: 'gpt-5', initialReview: 'unresolved' });
  withoutInterval.delete('interval');
  await expect(createWatch(null, withoutInterval)).rejects.toThrow('NEXT_REDIRECT');
  await expect(createWatch(null, form({ ...watchFields, target: 'PROJ-1', interval: ' ' }))).rejects.toThrow(
    'NEXT_REDIRECT',
  );
  const [mr, jira] = core.watches.list();
  expect(mr).toMatchObject({ intervalMs: null, model: 'gpt-5', initialReview: 'unresolved' });
  expect(jira).toMatchObject({ kind: 'jira', intervalMs: null });
});

test('createWatch reports an unknown Repository with the attempt file and echoes the values', async () => {
  const fields = { ...watchFields, repository: 'nope' };
  const result = await createWatch(null, form(fields));
  expect(result).toEqual({
    ok: false,
    error: { code: 'UNKNOWN_REPOSITORY', name: 'nope', known: ['api', 'pages'], attemptFile: expect.any(String) },
    values: fields,
  });
  if (result?.error.code !== 'UNKNOWN_REPOSITORY') throw new Error('unexpected');
  expect(fs.existsSync(result.error.attemptFile!)).toBe(true);
  expect(core.watches.list()).toEqual([]);
  expect(redirect).not.toHaveBeenCalled();
});

test('createWatch reports a duplicate open Watch', async () => {
  await expect(createWatch(null, form(watchFields))).rejects.toThrow('NEXT_REDIRECT');
  const [existing] = core.watches.list();
  expect(await createWatch(null, form(watchFields))).toEqual({
    ok: false,
    error: { code: 'DUPLICATE_WATCH', existing: { id: existing!.id, state: 'active', intervalMs: 30 * 60_000 } },
    values: watchFields,
  });
});

test('createWatch requires instructions for a free-form target', async () => {
  const fields = { ...watchFields, target: 'https://example.com/some/page', instructions: '  ' };
  expect(await createWatch(null, form(fields))).toEqual({
    ok: false,
    error: { code: 'MISSING_INSTRUCTIONS' },
    values: fields,
  });
});

test('createWatch rejects an interval that is not a positive duration', async () => {
  for (const interval of ['15 minutes', '0m']) {
    const fields = { ...watchFields, interval };
    expect(await createWatch(null, form(fields))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'interval' },
      values: fields,
    });
  }
  expect(core.watches.list()).toEqual([]);
});

test('createWatch rejects an unknown initial review mode', async () => {
  expect(await createWatch(null, form({ ...watchFields, initialReview: 'all' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'initialReview' },
  });
});

test('updateWatch saves the editable fields and redirects to the Watch', async () => {
  const id = insertWatch(core.db);
  const fields = {
    id: String(id),
    instructions: 'New text',
    interval: '2h',
    model: 'gpt-5',
    initialReview: 'unresolved',
  };
  await expect(updateWatch(null, form(fields))).rejects.toThrow(`NEXT_REDIRECT /watches/${id}`);
  expect(core.watches.get(id)).toMatchObject({
    instructions: 'New text',
    intervalMs: 2 * 3_600_000,
    model: 'gpt-5',
    initialReview: 'unresolved',
  });
});

test('updateWatch resets interval, model and initial review to the defaults when blank', async () => {
  const id = insertWatch(core.db);
  core.watches.update(id, { intervalMs: 60_000, model: 'gpt-5', initialReview: 'unresolved', instructions: 'x' });
  await expect(
    updateWatch(null, form({ id: String(id), instructions: '', interval: '', model: '', initialReview: '' })),
  ).rejects.toThrow('NEXT_REDIRECT');
  expect(core.watches.get(id)).toMatchObject({
    instructions: null,
    intervalMs: null,
    model: null,
    initialReview: null,
  });
});

test('updateWatch leaves the interval and initial review unchanged when the fields are missing', async () => {
  const id = insertWatch(core.db);
  core.watches.update(id, { intervalMs: 60_000, initialReview: 'unresolved' });
  await expect(updateWatch(null, form({ id: String(id), instructions: '', model: '' }))).rejects.toThrow(
    'NEXT_REDIRECT',
  );
  expect(core.watches.get(id)).toMatchObject({ intervalMs: 60_000, initialReview: 'unresolved' });
});

test('updateWatch returns errors with the echoed values', async () => {
  const id = insertWatch(core.db);
  const bad = { id: String(id), instructions: '', interval: 'soon', model: '' };
  expect(await updateWatch(null, form(bad))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'interval' },
    values: bad,
  });
  const missing = { id: '99999', instructions: '', model: '' };
  expect(await updateWatch(null, form(missing))).toEqual({ ok: false, error: { code: 'NOT_FOUND' }, values: missing });
  expect(redirect).not.toHaveBeenCalled();
});

test('previewTarget returns the kind and the MR preview', async () => {
  mrLookup.mockResolvedValue({ title: 'Add login', state: 'opened', sourceBranch: 'feat/login' } as Awaited<
    ReturnType<GitLabClient['mr']>
  >);
  expect(await previewTarget(MR_URL, 'pages')).toEqual({
    kind: 'mr',
    preview: { title: 'Add login', state: 'opened', sourceBranch: 'feat/login' },
  });
  expect(mrLookup).toHaveBeenCalledWith('team%2Fapp', 42);
});

test('previewTarget returns the kind with a reason when the preview fails, and the parse error for bad targets', async () => {
  mrLookup.mockRejectedValue(new Error('GitLab 401'));
  expect(await previewTarget(MR_URL, 'pages')).toEqual({ kind: 'mr', preview: null, previewError: 'GitLab 401' });
  expect(await previewTarget('not a target', 'pages')).toMatchObject({
    kind: null,
    preview: null,
    error: { code: 'INVALID_TARGET' },
  });
});
