import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { testConfig } from '../../../../test/helpers/config';
import { resolveSecrets } from '../../config/load';
import { acpCommand, createAcpDriver, type AcpProvider } from './acpDriver';
import { DriverError, type SessionEvent, type SessionHandle, type ToolPolicy } from './sessionDriver';

const FAKE = path.resolve('test/fixtures/fake-acp-agent.mjs');
const providers: AcpProvider[] = ['copilot', 'opencode', 'claude-code', 'codex'];
const open: ToolPolicy = { allowAll: true, allowed: [], blocked: [], denyTools: [] };
const cleanups: (() => void)[] = [];
const handles: SessionHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.kill();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Script = Record<string, unknown>;

function setup(provider: AcpProvider, script: Script = {}, extraEnv: Record<string, string> = {}) {
  const config = testConfig({
    providers: {
      copilot: { bin: FAKE, defaultModel: 'copilot-model', models: [] },
      opencode: { bin: FAKE, defaultModel: 'opencode-model', models: [] },
      'claude-code': { bin: 'claude', acpBin: FAKE, defaultModel: 'claude-model', models: [] },
      codex: { bin: 'codex', acpBin: FAKE, defaultModel: 'codex-model', models: [] },
    },
  });
  cleanups.push(() => fs.rmSync(config.configDir, { recursive: true, force: true }));
  const dir = path.join(config.configDir, 'session');
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, 'record.jsonl');
  const logPath = path.join(dir, 'session.log');
  const env = {
    ...process.env,
    FAKE_ACP_SCRIPT: JSON.stringify(script),
    FAKE_ACP_RECORD: record,
    GITLAB_TOKEN: 'gitlab-secret',
    OTHER_SERVICE_TOKEN: 'other-secret',
    ...extraEnv,
  };
  const driver = createAcpDriver(provider, config, resolveSecrets(config, env), {
    stdinGraceMs: 150,
    killGraceMs: 150,
  });
  const start = (overrides: Partial<Parameters<typeof driver.start>[0]> = {}) => {
    const handle = driver.start({
      cwd: dir,
      model: `${provider}-model`,
      env,
      logPath,
      tools: open,
      ...overrides,
    });
    handles.push(handle);
    const events: SessionEvent[] = [];
    handle.onEvent((event) => events.push(event));
    return { handle, events };
  };
  const received = (): {
    type: string;
    message: { method?: string; params?: Record<string, unknown>; id?: number };
  }[] =>
    fs.existsSync(record)
      ? fs
          .readFileSync(record, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const methods = () => received().flatMap((r) => (r.type === 'in' && r.message.method ? [r.message.method] : []));
  return { config, dir, record, logPath, env, start, received, methods };
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

describe.each(providers)('ACP driver (%s)', (provider) => {
  test("starts the provider's ACP command in the Chat copy with filtered credentials", async () => {
    const s = setup(provider);
    const { handle } = s.start();
    await handle.ready;

    const start = s.received().find((r) => r.type === 'start') as unknown as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    expect(fs.realpathSync(start.cwd)).toBe(fs.realpathSync(s.dir));
    expect(start.env.GITLAB_TOKEN).toBeUndefined();
    expect(start.env.OTHER_SERVICE_TOKEN).toBeUndefined();
    if (provider === 'opencode') expect(start.argv).toEqual(['acp']);
    if (provider === 'copilot') {
      expect(start.argv).toEqual(expect.arrayContaining(['--acp', '--model', 'copilot-model', '--allow-all-tools']));
      expect(start.argv).toEqual(expect.arrayContaining(['--secret-env-vars']));
    }
    if (provider === 'claude-code' || provider === 'codex') expect(start.argv).toEqual([]);
    expect(handle.pid).toBeGreaterThan(0);
  });

  test('initialize then session/new with cwd, model and mcpServers', async () => {
    const s = setup(provider);
    const { handle, events } = s.start({
      mcpServer: { name: 'automator', command: 'node', args: ['mcp.mjs'], env: { TOKEN_NONCE: 'abc' } },
    });
    const ready = await handle.ready;

    expect(ready).toEqual({ providerSessionId: 'fake-session-1' });
    expect(events).toContainEqual({ type: 'session', providerSessionId: 'fake-session-1' });
    const inbound = s.received().filter((r) => r.type === 'in');
    expect(inbound[0]!.message.method).toBe('initialize');
    // Native questions arrive in PR 4: elicitation must not be advertised yet.
    expect(inbound[0]!.message.params).toMatchObject({ protocolVersion: 1 });
    expect(JSON.stringify(inbound[0]!.message.params)).not.toContain('elicitation');
    expect(inbound[1]!.message).toMatchObject({
      method: 'session/new',
      params: {
        cwd: s.dir,
        mcpServers: [
          { name: 'automator', command: 'node', args: ['mcp.mjs'], env: [{ name: 'TOKEN_NONCE', value: 'abc' }] },
        ],
      },
    });
    const config = inbound.filter((r) => r.message.method === 'session/set_config_option').map((r) => r.message.params);
    if (provider === 'copilot') expect(config).toEqual([]);
    else
      expect(config[0]).toMatchObject({ sessionId: 'fake-session-1', configId: 'model', value: `${provider}-model` });
    if (provider === 'claude-code') {
      expect(config[1]).toMatchObject({ configId: 'mode', value: 'bypassPermissions' });
    } else {
      expect(config.filter((c) => (c as { configId: string }).configId === 'mode')).toEqual([]);
    }
  });

  test('resume uses session/load with the stored id', async () => {
    const s = setup(provider, { sessionId: 'stored-1' });
    const { handle, events } = s.start({ providerSessionId: 'stored-1' });
    expect(await handle.ready).toEqual({ providerSessionId: 'stored-1' });

    expect(s.methods()).toContain('session/load');
    expect(s.methods()).not.toContain('session/new');
    expect(events).toContainEqual({ type: 'session', providerSessionId: 'stored-1' });
  });

  test('resume fails with SESSION_RESUME_FAILED when loadSession is unsupported or rejected', async () => {
    for (const script of [
      { loadSession: false },
      { knownSessionId: 'other', sessionId: 'stored-1' },
      { failLoad: -32603 },
    ]) {
      const s = setup(provider, script);
      const { handle } = s.start({ providerSessionId: 'stored-1' });
      const error = await handle.ready.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DriverError);
      expect((error as DriverError).runError.code).toBe('SESSION_RESUME_FAILED');
      // A failed resume never silently starts a new provider session.
      expect(s.methods()).not.toContain('session/new');
    }
  });

  test('agent_message_chunk updates become text events and turn-end follows the prompt response', async () => {
    const s = setup(provider, { prompts: [{ updates: [{ text: 'Hel' }, { text: 'lo' }] }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('hi');
    await until(() => turnEnd(events));

    expect(texts(events)).toBe('Hello');
    expect(events).toContainEqual({ type: 'turn-start', prompted: true });
    expect(turnEnd(events)).toEqual({ type: 'turn-end', stopReason: 'end_turn' });
    const prompt = s.received().find((r) => r.type === 'in' && r.message.method === 'session/prompt');
    expect(prompt!.message.params).toEqual({ sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'hi' }] });
  });

  test('tool_call updates become tool-call events', async () => {
    const s = setup(provider, {
      prompts: [
        {
          updates: [
            { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', status: 'pending', kind: 'execute' },
            { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'echo hi', status: 'in_progress' },
            { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
            { sessionUpdate: 'usage_update', used: 1, size: 2 },
          ],
        },
      ],
    });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('go');
    await until(() => turnEnd(events));

    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', id: 't1', title: 'Terminal', status: 'pending' },
      { type: 'tool-call', id: 't1', title: 'echo hi', status: 'in_progress' },
      { type: 'tool-call', id: 't1', title: 'echo hi', status: 'completed' },
    ]);
  });

  test('permission requests are answered by policy and never surface as questions', async () => {
    const permission = (name: string, kind: string) => ({
      toolCall: { toolCallId: 'p1', name, title: name, kind, status: 'pending', rawInput: {} },
    });
    const run = async (policy: ToolPolicy, tool: string) => {
      const s = setup(provider, { prompts: [{ permission: permission(tool, 'execute') }] });
      const { handle, events } = s.start({ tools: policy });
      await handle.ready;
      await handle.send('go');
      await until(() => turnEnd(events));
      const answer = s.received().find((r) => r.type === ('permission-answer' as string)) as unknown as {
        answer: { outcome: { outcome: string; optionId?: string } };
      };
      return { events, answer: answer.answer.outcome };
    };

    const allowed = await run(open, 'Bash');
    expect(allowed.answer).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(allowed.events).toContainEqual({ type: 'permission', tool: 'Bash', decision: 'allow' });
    expect(allowed.events.some((e) => e.type === 'question')).toBe(false);

    const denied = await run({ ...open, denyTools: ['Bash'] }, 'Bash');
    expect(denied.answer).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(denied.events).toContainEqual({ type: 'permission', tool: 'Bash', decision: 'deny' });
  });

  test('a second send while a turn is in flight is rejected', async () => {
    const s = setup(provider, { prompts: [{ hang: true }] });
    const { handle } = s.start();
    await handle.ready;
    await handle.send('one');
    await expect(handle.send('two')).rejects.toThrow(/turn is in flight/);
  });

  test('cancelTurn sends session/cancel and the turn ends cancelled', async () => {
    const s = setup(provider, { prompts: [{ waitForCancel: true }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('long');
    await until(() => (s.methods().includes('session/prompt') ? true : undefined));
    handle.cancelTurn();

    expect(await until(() => turnEnd(events))).toEqual({ type: 'turn-end', stopReason: 'cancelled' });
    expect(s.methods()).toContain('session/cancel');
    // The session accepts the next prompt.
    await handle.send('again');
  });

  test('a crash mid-turn emits an error turn-end then exit', async () => {
    const s = setup(provider, { prompts: [{ updates: [{ text: 'partial' }], crash: 3 }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('boom');
    await until(() => events.find((e) => e.type === 'exit'));

    const types = events.map((e) => e.type);
    expect(types.indexOf('turn-end')).toBeLessThan(types.indexOf('exit'));
    expect(turnEnd(events)).toMatchObject({
      stopReason: 'error',
      error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('exited') },
    });
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ exit: { code: 3 } });
    await expect(handle.send('after')).rejects.toThrow();
  });

  test('stop closes stdin and exits without a signal when the process cooperates', async () => {
    const s = setup(provider);
    const { handle } = s.start();
    await handle.ready;
    expect(await handle.stop()).toMatchObject({ code: 0, signal: null });
  });

  test('stop escalates to SIGTERM and SIGKILL', async () => {
    const term = setup(provider, { ignoreStdinEnd: true });
    const a = term.start();
    await a.handle.ready;
    expect(await a.handle.stop()).toMatchObject({ code: 0 });

    const kill = setup(provider, { ignoreStdinEnd: true, ignoreSigterm: true });
    const b = kill.start();
    await b.handle.ready;
    expect(await b.handle.stop()).toMatchObject({ signal: 'SIGKILL' });
  });

  test('native questions are declined until PR 4 and logged', async () => {
    const s = setup(provider, { prompts: [{ elicitation: { message: 'Which color?' } }] });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('ask');
    await until(() => turnEnd(events));

    const answer = s.received().find((r) => r.type === ('elicitation-answer' as string)) as unknown as {
      answer: unknown;
    };
    expect(answer.answer).toEqual({ action: 'cancel' });
    expect(events.some((e) => e.type === 'question')).toBe(false);
    expect(fs.readFileSync(s.logPath, 'utf8')).toContain('declined native question');
  });

  test('updates without an active prompt emit turn-start prompted=false', async () => {
    const s = setup(provider, {
      prompts: [{ updates: [{ text: 'ok' }], unprompted: { afterMs: 30, updates: [{ text: 'tick' }] } }],
    });
    const { handle, events } = s.start();
    await handle.ready;
    await handle.send('set a timer');
    await until(() => events.find((e) => e.type === 'turn-start' && !e.prompted));

    expect(events).toContainEqual({ type: 'turn-start', prompted: false });
    await until(() => (texts(events).includes('tick') ? true : undefined));
    expect(texts(events)).toBe('oktick');
  });

  test('updates before the first prompt and during session/load are swallowed', async () => {
    const s = setup(provider, { sessionId: 'stored-1', replay: ['old answer'], autoModeNotice: true });
    const { handle, events } = s.start({ providerSessionId: 'stored-1' });
    await handle.ready;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.filter((e) => e.type === 'text')).toEqual([]);
    expect(events.some((e) => e.type === 'turn-start')).toBe(false);
  });

  test('auth status payloads and emails never reach the log', async () => {
    const s = setup(provider, { authNoise: true });
    const { handle } = s.start();
    await handle.ready;
    await handle.send('hi');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const log = fs.readFileSync(s.logPath, 'utf8');
    expect(log).not.toContain('person@example.com');
    expect(log).toContain('auth/status_update');
    expect(log).toContain('(redacted)');
    expect(log).toContain('session/prompt');
  });

  test('a missing executable fails with SPAWN_FAILED and a troubleshooting hint', async () => {
    const s = setup(provider);
    const config = testConfig({
      providers: {
        copilot: { bin: '/nonexistent/acp-bin', defaultModel: 'm', models: [] },
        opencode: { bin: '/nonexistent/acp-bin', defaultModel: 'm', models: [] },
        'claude-code': { acpBin: '/nonexistent/acp-bin', defaultModel: 'm', models: [] },
        codex: { acpBin: '/nonexistent/acp-bin', defaultModel: 'm', models: [] },
      },
    });
    cleanups.push(() => fs.rmSync(config.configDir, { recursive: true, force: true }));
    const driver = createAcpDriver(provider, config, resolveSecrets(config, s.env));
    const handle = driver.start({ cwd: s.dir, model: 'm', env: s.env, logPath: s.logPath, tools: open });
    handles.push(handle);

    const error = await handle.ready.catch((e: unknown) => e);
    expect((error as DriverError).runError.code).toBe('SPAWN_FAILED');
    expect((error as DriverError).runError.message).toContain('/nonexistent/acp-bin');
    if (provider === 'claude-code' || provider === 'codex') {
      expect((error as DriverError).runError.message).toContain('README');
    }
    expect(await handle.exited).toMatchObject({ error: { code: 'SPAWN_FAILED' } });
  });

  test('pending requests are rejected when the process exits before it is ready', async () => {
    const s = setup(provider, { exitImmediately: 7 });
    const { handle } = s.start();
    const error = await handle.ready.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverError);
    expect((error as DriverError).runError.code).toBe('PROVIDER_ERROR');
    expect((error as DriverError).runError.message).toContain('exited');
  });

  test('a rejected model selection is reported as MODEL_UNSUPPORTED', async () => {
    if (provider === 'copilot') return; // Copilot receives --model at start
    const s = setup(provider, { rejectConfig: 'model' });
    const { handle } = s.start();
    const error = await handle.ready.catch((e: unknown) => e);
    expect((error as DriverError).runError.code).toBe('MODEL_UNSUPPORTED');
  });
});

describe('acpCommand', () => {
  test('builds each provider command line', () => {
    const config = testConfig({
      providers: {
        copilot: { bin: 'copilot-bin', defaultModel: 'm', models: [] },
        opencode: { bin: 'opencode-bin', defaultModel: 'm', models: [] },
        'claude-code': { acpBin: '/opt/claude-agent-acp', defaultModel: 'm', models: [] },
        codex: { acpBin: '/opt/codex-acp', defaultModel: 'm', models: [] },
      },
    });
    const start = { model: 'chosen', tools: open, secretEnvNames: ['GITLAB_TOKEN'] };
    expect(acpCommand(config, 'opencode', start)).toEqual({ bin: 'opencode-bin', args: ['acp'] });
    expect(acpCommand(config, 'claude-code', start)).toEqual({ bin: '/opt/claude-agent-acp', args: [] });
    expect(acpCommand(config, 'codex', start)).toEqual({ bin: '/opt/codex-acp', args: [] });
    expect(acpCommand(config, 'copilot', start)).toEqual({
      bin: 'copilot-bin',
      args: ['--acp', '--model', 'chosen', '--allow-all-tools', '--secret-env-vars', 'GITLAB_TOKEN'],
      preserveCopilotAuth: true,
    });
  });
});
