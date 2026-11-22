#!/usr/bin/env node
// Scriptable fake `pi --mode rpc`. It replays the exchanges captured in the provider spike
// (docs/superpowers/specs/2026-11-14-interactive-chats-provider-spike.md): get_state, prompt with a
// `started` disposition, agent_start / message_update text_delta / agent_end / agent_settled, abort,
// extension_ui_request dialogs, and the exit code 1 + "No session found" stderr for an unknown --session.
//
// FAKE_PI_SCRIPT   JSON script
// FAKE_PI_RECORD   file that receives one JSON line per start/received/sent record
import fs from 'node:fs';
import process from 'node:process';

const script = JSON.parse(process.env.FAKE_PI_SCRIPT ?? '{}');
const argv = process.argv.slice(2);
const arg = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const record = (entry) => {
  if (process.env.FAKE_PI_RECORD) fs.appendFileSync(process.env.FAKE_PI_RECORD, `${JSON.stringify(entry)}\n`);
};
record({ type: 'start', argv, cwd: process.cwd(), env: process.env });

const resume = arg('--session');
if (resume !== undefined && !(script.knownSessions ?? []).includes(resume)) {
  process.stderr.write(`No session found matching '${resume}'\n`);
  process.exit(1);
}
if (script.exitImmediately !== undefined) process.exit(script.exitImmediately);
if (script.ignoreSigterm) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => process.exit(0));

const sessionId = arg('--session-id') ?? resume ?? 'pi-fake-session';
const send = (message) => {
  record({ type: 'out', message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (script.noise) {
  send({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'Some user extension is on',
    notifyType: 'info',
  });
  send({ type: 'extension_ui_request', id: 'n2', method: 'setStatus', statusKey: 'goal' });
}

let promptCount = 0;
let abortWake = null;
let aborted = false;
const uiPending = new Map();

const systemMessage = { role: 'system', content: '', sections: { preamble: 'You are a coding assistant.' } };
const assistant = (text, stopReason = 'stop', errorMessage) => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking: 'hmm' }, ...(text === '' ? [] : [{ type: 'text', text }])],
  stopReason,
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

async function runPrompt(message) {
  const steps = script.prompts ?? [{ text: 'ok' }];
  const step = steps[Math.min(promptCount, steps.length - 1)];
  promptCount += 1;
  aborted = false;
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  send({ type: 'message_start', message: systemMessage });
  send({ type: 'message_end', message: systemMessage });
  const user = { role: 'user', content: [{ type: 'text', text: message }] };
  send({ type: 'message_start', message: user });
  send({ type: 'message_end', message: user });
  send({ type: 'message_start', message: assistant('', 'pending') });
  for (const delta of step.deltas ?? (step.text === undefined ? [] : [step.text])) {
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta } });
    if (step.pauseMs) await sleep(step.pauseMs);
  }
  if (step.tool) {
    send({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: step.tool, args: {} });
    send({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: step.tool,
      result: {},
      isError: step.toolError === true,
    });
  }
  if (step.ui) {
    const id = 'ui-1';
    send({ type: 'extension_ui_request', id, ...step.ui });
    await new Promise((resolve) => uiPending.set(id, resolve));
  }
  if (step.crash !== undefined) process.exit(step.crash);
  if (step.waitForAbort) {
    await new Promise((resolve) => {
      abortWake = resolve;
      if (aborted) resolve();
    });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled', aborted: true });
    return;
  }
  if (step.hang) return;
  const done = assistant(
    step.deltas ? step.deltas.join('') : (step.text ?? ''),
    step.error ? 'error' : 'stop',
    step.error,
  );
  send({ type: 'message_end', message: done });
  send({ type: 'turn_end', message: done });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'agent_settled', aborted: false });
}

function handle(command) {
  const respond = (extra = {}) =>
    send({ id: command.id, type: 'response', command: command.type, success: true, ...extra });
  if (command.type === 'get_state') {
    return respond({
      data: {
        model: { id: arg('--model'), provider: 'fake' },
        thinkingLevel: 'medium',
        isStreaming: false,
        sessionId,
        messageCount: resume === undefined ? 0 : 3,
        pendingMessageCount: 0,
      },
    });
  }
  if (command.type === 'prompt') {
    if (script.rejectPrompt) {
      return send({ id: command.id, type: 'response', command: 'prompt', success: false, error: script.rejectPrompt });
    }
    respond({ data: { disposition: script.disposition ?? 'started' } });
    if ((script.disposition ?? 'started') === 'started') void runPrompt(command.message);
    return undefined;
  }
  if (command.type === 'abort') {
    aborted = true;
    if (script.ignoreAbort) return undefined;
    abortWake?.();
    return respond();
  }
  if (command.type === 'extension_ui_response') {
    record({ type: 'ui-response', response: command });
    uiPending.get(command.id)?.();
    return undefined;
  }
  return send({
    id: command.id,
    type: 'response',
    command: command.type,
    success: false,
    error: `Unknown command ${command.type}`,
  });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === '') continue;
    const command = JSON.parse(line);
    record({ type: 'in', message: command });
    handle(command);
  }
});
process.stdin.on('end', () => {
  if (!script.ignoreStdinEnd) process.exit(0);
});
if (script.ignoreStdinEnd) setInterval(() => {}, 1000);
