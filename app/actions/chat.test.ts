import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCore, type Core } from '@core/index';
import { fakeClock } from '../../test/helpers/clock';
import { testConfig } from '../../test/helpers/config';

const holder = vi.hoisted(() => ({ core: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../lib/core', () => ({ getCore: () => holder.core }));
const guardState = vi.hoisted(() => ({ denyWrite: false }));
vi.mock('../lib/guard', async () => {
  const allowAll = (await import('../lib/guard.mock')).allowAll;
  return {
    ...allowAll,
    requireWriteOnRun: async () =>
      guardState.denyWrite
        ? { ok: false as const, error: { code: 'FORBIDDEN' as const } }
        : { ok: true as const, userId: 1 },
  };
});
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { sendRunMessage, branchRun, closeChat } = await import('./chat');

let core: Core;

beforeEach(() => {
  const config = testConfig();
  core = createCore(
    config,
    { clock: fakeClock(), notifier: { async notifyNeedsYou() {} } },
    { repositories: config.repositories },
  );
  holder.core = core;
  revalidatePath.mockClear();
  guardState.denyWrite = false;
});

afterEach(() => core.close());

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

function finishedAdhoc() {
  const run = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'first', model: 'm' });
  core.db.prepare("UPDATE runs SET status = 'finished', session_id = 'sess-1' WHERE id = ?").run(run.id);
  return run;
}

test('queues a follow-up and revalidates', async () => {
  const parent = finishedAdhoc();

  const result = await sendRunMessage(null, form({ runId: String(parent.id), message: ' and now this ' }));

  expect(result).toEqual({ ok: true, value: { runId: parent.id + 1 } });
  expect(
    core.db
      .prepare('SELECT status, adhoc_prompt AS prompt, parent_run_id AS parent FROM runs WHERE id = ?')
      .get(parent.id + 1),
  ).toEqual({ status: 'queued', prompt: 'and now this', parent: parent.id });
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test.each(['abc', '0', '-1', '1.5', ''])('returns INVALID_INPUT for the runId %j', async (runId) => {
  const fields = { runId, message: 'hi' };

  expect(await sendRunMessage(null, form(fields))).toEqual({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'runId', message: expect.any(String) },
    values: { message: 'hi' },
  });
  expect(revalidatePath).not.toHaveBeenCalled();
});

test('echoes the message when the queue rejects it', async () => {
  const parent = finishedAdhoc();

  const result = await sendRunMessage(null, form({ runId: String(parent.id), message: '   ' }));

  expect(result).toEqual({
    ok: false,
    error: { code: 'INVALID_INPUT', field: 'message', message: 'Message is required' },
    values: { message: '   ' },
  });
  expect(core.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(revalidatePath).not.toHaveBeenCalled();
});

test('branchRun creates a new chat from a finished Run and redirects to it', async () => {
  const run = finishedAdhoc();
  await expect(branchRun(null, form({ runId: String(run.id), message: 'other way' }))).rejects.toThrow(
    /REDIRECT:\/runs\/\d+/,
  );
  const branch = core.db.prepare('SELECT * FROM runs WHERE branched_from_run_id = ?').get(run.id) as {
    parent_run_id: number | null;
    session_id: string | null;
    adhoc_prompt: string;
  };
  expect(branch).toMatchObject({ parent_run_id: null, session_id: null, adhoc_prompt: 'other way' });
});

test('branchRun reports an unfinished Run', async () => {
  const run = core.queue.enqueueAdhoc({ repository: 'pages', prompt: 'first', model: 'm' });
  const result = await branchRun(null, form({ runId: String(run.id), message: 'x' }));
  expect(result).toMatchObject({ ok: false, values: { message: 'x' } });
});

test('branchRun keeps the mode', async () => {
  const session = core.chats.create({ repository: 'pages', provider: 'copilot', model: 'm', agentId: null });
  const run = finishedAdhoc();
  core.db.prepare('UPDATE runs SET chat_session_id = ? WHERE id = ?').run(session.id, run.id);
  await expect(branchRun(null, form({ runId: String(run.id), message: 'other way' }))).rejects.toThrow(
    /REDIRECT:\/runs\/\d+/,
  );
  const branch = core.db.prepare('SELECT chat_session_id FROM runs WHERE branched_from_run_id = ?').get(run.id) as {
    chat_session_id: number | null;
  };
  expect(branch.chat_session_id).not.toBeNull();
  expect(branch.chat_session_id).not.toBe(session.id);
  expect(core.chats.modeOfRun(run.id)).toBe('interactive');

  const plain = finishedAdhoc();
  await expect(branchRun(null, form({ runId: String(plain.id), message: 'x' }))).rejects.toThrow(/REDIRECT/);
  expect(core.db.prepare('SELECT chat_session_id FROM runs WHERE branched_from_run_id = ?').get(plain.id)).toEqual({
    chat_session_id: null,
  });
});

function interactiveChat(opts: { dirty?: boolean; copy?: boolean } = {}) {
  const session = core.chats.create({ repository: 'pages', provider: 'pi', model: 'm', agentId: null });
  const run = finishedAdhoc();
  core.db.prepare('UPDATE runs SET chat_session_id = ? WHERE id = ?').run(session.id, run.id);
  if (opts.copy !== false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-copy-'));
    cleanupDirs.push(root);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@e.c', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });
    // A pushed state: the copy is a clone of a remote that has every commit.
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const copy = path.join(root, 'copy');
    git(root, 'init', '--bare', '-b', 'main', remote);
    git(root, 'init', '-b', 'main', seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'one');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', 'origin', 'main');
    git(root, 'clone', remote, copy);
    if (opts.dirty) fs.writeFileSync(path.join(copy, 'b.txt'), 'dirty');
    core.db.prepare('UPDATE chat_sessions SET copy_path = ? WHERE id = ?').run(copy, session.id);
  }
  return { run, session };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const closeRequested = (id: number) =>
  (core.db.prepare('SELECT close_requested_at AS at FROM chat_sessions WHERE id = ?').get(id) as { at: number | null })
    .at;

test('closeChat with uncommitted or unpushed work returns needsConfirmation and does not close', async () => {
  const { run, session } = interactiveChat({ dirty: true });

  const result = await closeChat(run.id, false);

  expect(result).toEqual({
    ok: false,
    needsConfirmation: true,
    work: { uncommitted: true, unpushedCommits: 0, unknown: false },
  });
  expect(closeRequested(session.id)).toBeNull();
});

test('closeChat requires confirmation when the work check fails', async () => {
  const { run, session } = interactiveChat();
  // A copy that is not a git repository: every git check fails, which must never read as "no work".
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-plain-'));
  cleanupDirs.push(plain);
  core.db.prepare('UPDATE chat_sessions SET copy_path = ? WHERE id = ?').run(plain, session.id);

  expect(await closeChat(run.id, false)).toMatchObject({ ok: false, needsConfirmation: true, work: { unknown: true } });
  expect(closeRequested(session.id)).toBeNull();
});

test('closeChat with confirm requests the close', async () => {
  const { run, session } = interactiveChat({ dirty: true });

  expect(await closeChat(run.id, true)).toEqual({ ok: true });

  expect(closeRequested(session.id)).not.toBeNull();
  expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
});

test('closeChat of a clean copy closes without confirmation', async () => {
  const { run, session } = interactiveChat();
  expect(await closeChat(run.id, false)).toEqual({ ok: true });
  expect(closeRequested(session.id)).not.toBeNull();
});

test('closeChat of a Chat that never started has nothing to lose', async () => {
  const { run, session } = interactiveChat({ copy: false });
  expect(await closeChat(run.id, false)).toEqual({ ok: true });
  expect(closeRequested(session.id)).not.toBeNull();
});

test('closeChat needs write on the Run', async () => {
  const { run, session } = interactiveChat();
  guardState.denyWrite = true;

  expect(await closeChat(run.id, true)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(closeRequested(session.id)).toBeNull();
});

test('closeChat rejects a Follow-up Chat and a running turn', async () => {
  const plain = finishedAdhoc();
  expect(await closeChat(plain.id, true)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

  const { run } = interactiveChat();
  core.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
  expect(await closeChat(run.id, true)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
});
