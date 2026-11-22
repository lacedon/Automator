import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { testConfig } from '../../../../test/helpers/config';
import { resolveSecrets } from '../../config/load';
import { createPiRpcDriver } from './piRpcDriver';
import { DriverError, type SessionEvent, type SessionHandle, type ToolPolicy } from './sessionDriver';

const FAKE = path.resolve('test/fixtures/fake-pi-rpc.mjs');
const open: ToolPolicy = { allowAll: true, allowed: [], blocked: [], denyTools: [] };
const cleanups: (() => void)[] = [];
const handles: SessionHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.kill();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Script = Record<string, unknown>;
type Rec = {
  type: string;
  argv?: string[];
  env?: Record<string, string>;
  message?: Record<string, unknown>;
  response?: unknown;
};

function setup(script: Script = {}, bin = FAKE) {
  const config = testConfig({ providers: { pi: { bin, defaultModel: 'pi-model', models: [] } } });
  cleanups.push(() => fs.rmSync(config.configDir, { recursive: true, force: true }));
  const dir = path.join(config.configDir, 'session');
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, 'record.jsonl');
  const logPath = path.join(dir, 'session.log');
  const env = {
    ...process.env,
    FAKE_PI_SCRIPT: JSON.stringify(script),
    FAKE_PI_RECORD: record,
    GITLAB_TOKEN: 'gitlab-secret',
    OTHER_SERVICE_TOKEN: 'other-secret',
  };
  const driver = createPiRpcDriver(config, resolveSecrets(config, env), {
    stdinGraceMs: 150,
    killGraceMs: 150,
    abortDeadlineMs: 150,
    requestTimeoutMs: 150,
  });
  const start = (overrides: Partial<Parameters<typeof driver.start>[0]> = {}) => {
    const handle = driver.start({
      cwd: dir,
      model: 'pi-model',
      env,
      logPath,
      tools: open,
      sessionDir: path.join(dir, 'pi-sessions'),
      ...overrides,
    });
    handles.push(handle);
    const events: SessionEvent[] = [];
    handle.onEvent((event) => events.push(event));
    return { handle, events };
  };
  const received = (): Rec[] =>
    fs.existsSync(record)
      ? fs
          .readFileSync(record, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Rec)
      : [];
  const commands = () => received().flatMap((r) => (r.type === 'in' ? [r.message!] : []));
  const argv = () => received().find((r) => r.type === 'start')!.argv!;
  return { config, dir, record, logPath, env, start, received, commands, argv };
}

async function until<T>(read: () => T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const turnEnd = (events: SessionEvent[]) => events.find((e) => e.type === 'turn-end');
const texts = (events: SessionEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

describe('pi RPC driver', () => {
  test('starts pi --mode rpc with model, session and exclude-tools', async () => {
    const s = setup();
    const { handle, events } = s.start({ tools: { ...open, denyTools: ['bash', 'write'] } });
    const ready = await handle.ready;

    const argv = s.argv();
    expect(argv.slice(0, 2)).toEqual(['--mode', 'rpc']);
    expect(argv).toEqual(
      expect.arrayContaining(['--no-extensions', '--model', 'pi-model', '--exclude-tools', 'bash,write']),
    );
    expect(argv[argv.indexOf('--session-dir') + 1]).toBe(path.join(s.dir, 'pi-sessions'));
    // A new session gets an id generated on our side; it is stored as provider_session_id.
    const id = argv[argv.indexOf('--session-id') + 1]!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv).not.toContain('--session');
    expect(ready).toEqual({ providerSessionId: id });
    expect(events).toContainEqual({ type: 'session', providerSessionId: id });
    expect(s.commands()[0]).toMatchObject({ type: 'get_state' });
    const start = s.received().find((r) => r.type === 'start')!;
    expect(start.env!.GITLAB_TOKEN).toBeUndefined();
    expect(start.env!.OTHER_SERVICE_TOKEN).toBeUndefined();
  });

  test('prompt command starts a turn and message_update text deltas stream', async () => {
    const s = setup({ prompts: [{ deltas: ['Hel', 'lo'], tool: 'bash' }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('hi there');
    await until(() => turnEnd(events));

    expect(s.commands().find((c) => c.type === 'prompt')).toMatchObject({ type: 'prompt', message: 'hi there' });
    expect(texts(events)).toBe('Hello');
    expect(events).toContainEqual({ type: 'turn-start', prompted: true });
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', id: 'tc1', title: 'bash', status: 'in_progress' },
      { type: 'tool-call', id: 'tc1', title: 'bash', status: 'completed' },
    ]);
  });

  test('agent_settled, not agent_end, settles the turn and the system message is never emitted', async () => {
    const s = setup({ prompts: [{ text: 'ok' }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('hi');
    await until(() => turnEnd(events));

    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end', stopReason: 'end_turn' }]);
    expect(texts(events)).toBe('ok');
    expect(JSON.stringify(events)).not.toContain('You are a coding assistant');
    expect(fs.readFileSync(s.logPath, 'utf8')).not.toContain('You are a coding assistant');
  });

  test('a non-started prompt disposition settles immediately', async () => {
    const s = setup({ disposition: 'handled' });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('/some-command');

    expect(await until(() => turnEnd(events))).toEqual({ type: 'turn-end', stopReason: 'end_turn' });
    await handle.send('again');
  });

  test('a rejected prompt command ends the turn with an error', async () => {
    const s = setup({ rejectPrompt: 'Model not found' });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('hi');

    expect(await until(() => turnEnd(events))).toMatchObject({
      stopReason: 'error',
      error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('Model not found') },
    });
  });

  test('a provider error reported in the assistant message ends the turn with an error', async () => {
    const s = setup({ prompts: [{ text: '', error: 'Rate limited' }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('hi');

    expect(await until(() => turnEnd(events))).toMatchObject({
      stopReason: 'error',
      error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('Rate limited') },
    });
  });

  test('a second send while a turn is in flight is rejected', async () => {
    const s = setup({ prompts: [{ hang: true }] });
    const { handle } = s.start();
    await handle.ready;
    await handle.send('one');
    await expect(handle.send('two')).rejects.toThrow(/turn is in flight/);
  });

  test('abort cancels', async () => {
    const s = setup({ prompts: [{ waitForAbort: true }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('long');
    await until(() => (s.commands().some((c) => c.type === 'prompt') ? true : undefined));
    handle.cancelTurn();

    expect(await until(() => turnEnd(events))).toEqual({ type: 'turn-end', stopReason: 'cancelled' });
    expect(s.commands().some((c) => c.type === 'abort')).toBe(true);
    expect(events.some((e) => e.type === 'exit')).toBe(false);
  });

  test('an abort that never settles escalates to stop() after the deadline', async () => {
    const s = setup({ prompts: [{ hang: true }], ignoreAbort: true });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('stuck');
    handle.cancelTurn();

    await until(() => events.find((e) => e.type === 'exit'));
    expect(turnEnd(events)).toEqual({ type: 'turn-end', stopReason: 'cancelled' });
  });

  test('resume by session id uses --session', async () => {
    const s = setup({ knownSessions: ['stored-1'] });
    const { handle } = s.start({ providerSessionId: 'stored-1' });

    expect(await handle.ready).toEqual({ providerSessionId: 'stored-1' });
    expect(s.argv()).toEqual(expect.arrayContaining(['--session', 'stored-1']));
    expect(s.argv()).not.toContain('--session-id');
  });

  test('an unknown session fails with SESSION_RESUME_FAILED and never starts a new one', async () => {
    const s = setup({ knownSessions: [] });
    const { handle } = s.start({ providerSessionId: 'gone-1' });
    const error = await handle.ready.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriverError);
    expect((error as DriverError).runError.code).toBe('SESSION_RESUME_FAILED');
    expect((error as DriverError).runError.message).toContain('No session found');
    expect(s.argv()).not.toContain('--session-id');
  });

  test('extension UI noise is ignored and dialogs are declined until PR 4', async () => {
    const s = setup({
      noise: true,
      prompts: [{ text: 'done', ui: { method: 'select', title: 'Pick one', options: ['red', 'blue'] } }],
    });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('ask');
    await until(() => turnEnd(events));

    const response = s.received().find((r) => r.type === 'ui-response')!.response;
    expect(response).toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true });
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(fs.readFileSync(s.logPath, 'utf8')).toContain('declined extension dialog (select)');
  });

  test('a get_state that is never answered fails the start and stops the process', async () => {
    const s = setup({ hangGetState: true });
    const { handle } = s.start();

    const error = await handle.ready.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriverError);
    expect((error as DriverError).runError.message).toContain('get_state');
    expect(await handle.exited).toMatchObject({ signal: 'SIGKILL' });
  });

  test('stderr is redacted in the log and in the error, and only a bounded tail is kept', async () => {
    const noise = Array.from({ length: 200 }, (_, i) => `warning ${i}: contact person@example.com ${'x'.repeat(40)}`);
    const s = setup({ stderrLines: [...noise, 'fatal: stopping'], exitImmediately: 2 });
    const { handle } = s.start();

    const error = (await handle.ready.catch((e: unknown) => e)) as DriverError;

    const message = error.runError.message;
    expect(message).toContain('fatal: stopping');
    expect(message).not.toContain('person@example.com');
    expect(message.length).toBeLessThan(2_300);
    const log = fs.readFileSync(s.logPath, 'utf8');
    expect(log).not.toContain('person@example.com');
    expect(log).toContain('<redacted-email>');
  });

  test('a crash mid-turn emits an error turn-end then exit', async () => {
    const s = setup({ prompts: [{ text: 'partial', crash: 4 }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('boom');
    await until(() => events.find((e) => e.type === 'exit'));

    const types = events.map((e) => e.type);
    expect(types.indexOf('turn-end')).toBeLessThan(types.indexOf('exit'));
    expect(turnEnd(events)).toMatchObject({ stopReason: 'error', error: { code: 'PROVIDER_ERROR' } });
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ exit: { code: 4 } });
    await expect(handle.send('after')).rejects.toThrow();
  });

  test('stop closes stdin, then escalates to SIGTERM and SIGKILL', async () => {
    const calm = setup();
    const a = calm.start();
    await a.handle.ready;
    expect(await a.handle.stop()).toMatchObject({ code: 0, signal: null });

    const term = setup({ ignoreStdinEnd: true });
    const b = term.start();
    await b.handle.ready;
    expect(await b.handle.stop()).toMatchObject({ code: 0 });

    const stubborn = setup({ ignoreStdinEnd: true, ignoreSigterm: true });
    const c = stubborn.start();
    await c.handle.ready;
    expect(await c.handle.stop()).toMatchObject({ signal: 'SIGKILL' });
  });

  test('a missing executable fails with SPAWN_FAILED', async () => {
    const s = setup({}, '/nonexistent/pi');
    const { handle } = s.start();
    const error = await handle.ready.catch((e: unknown) => e);

    expect((error as DriverError).runError.code).toBe('SPAWN_FAILED');
    expect((error as DriverError).runError.message).toContain('/nonexistent/pi');
  });

  test('an early exit rejects ready with the process error', async () => {
    const s = setup({ exitImmediately: 9 });
    const { handle } = s.start();
    const error = await handle.ready.catch((e: unknown) => e);

    expect((error as DriverError).runError).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('code 9'),
    });
  });
});
