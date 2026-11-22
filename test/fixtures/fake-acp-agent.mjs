#!/usr/bin/env node
// Scriptable fake ACP agent. It replays the exchanges captured in the provider spike
// (docs/superpowers/specs/2026-11-14-interactive-chats-provider-spike.md): initialize, session/new,
// session/load (with history replay or the -32002 error), session/set_config_option, session/prompt with
// agent_message_chunk / tool_call / session/request_permission / elicitation/create, session/cancel and
// unsolicited updates while idle.
//
// FAKE_ACP_SCRIPT   JSON script (see `script` below for the keys)
// FAKE_ACP_RECORD   file that receives one JSON line per start/received/sent message
import fs from 'node:fs';
import process from 'node:process';

const script = JSON.parse(process.env.FAKE_ACP_SCRIPT ?? '{}');
const recordFile = process.env.FAKE_ACP_RECORD;
const record = (entry) => {
  if (recordFile) fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};
record({ type: 'start', argv: process.argv.slice(2), cwd: process.cwd(), env: process.env });

if (script.exitImmediately !== undefined) process.exit(script.exitImmediately);
if (script.ignoreSigterm) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => process.exit(0));

const send = (message) => {
  record({ type: 'out', message });
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
};
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sessionId = script.sessionId ?? 'fake-session-1';
let known = false;
let promptCount = 0;
let cancelled = false;
let wake = null;
let nextClientRequestId = 1000;
const clientPending = new Map();

function clientRequest(method, params) {
  const id = nextClientRequestId++;
  return new Promise((resolve) => {
    clientPending.set(id, resolve);
    send({ id, method, params });
  });
}

const capabilities = {
  loadSession: script.loadSession !== false,
  promptCapabilities: { image: true, embeddedContext: true },
  mcpCapabilities: { http: true, sse: true, acp: true },
};

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: capabilities,
        agentInfo: { name: 'fake-acp-agent', title: 'Fake Agent', version: '0.0.0' },
        authMethods: [],
      },
    });
  }
  if (method === 'session/new') {
    known = true;
    send({
      id,
      result: {
        sessionId,
        modes: { currentModeId: 'auto', availableModes: [] },
        configOptions: [{ id: 'model', currentValue: 'sonnet', options: [] }],
      },
    });
    // The adapter reports its account in a notification that Automator must never log verbatim.
    if (script.authNoise) {
      send({
        method: '_auth/status_update',
        params: { authStatus: { kind: 'account', account: { email: 'person@example.com' } } },
      });
      send({
        method: 'auth/status_update',
        params: { state: 'authenticated', accounts: [{ email: 'person@example.com' }] },
      });
    }
    return undefined;
  }
  if (method === 'session/load') {
    if (script.failLoad !== undefined || params.sessionId !== (script.knownSessionId ?? sessionId)) {
      return send({
        id,
        error: {
          code: script.failLoad ?? -32002,
          message: 'Resource not found',
          data: { sessionId: params.sessionId },
        },
      });
    }
    known = true;
    for (const text of script.replay ?? []) {
      update(params.sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: `replayed ${text}` },
      });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    }
    return send({
      id,
      result: {
        sessionId: params.sessionId,
        modes: { currentModeId: 'default', availableModes: [] },
        configOptions: [{ id: 'model', currentValue: 'sonnet', options: [] }],
      },
    });
  }
  if (method === 'session/set_config_option') {
    if (script.rejectConfig === params.configId) {
      return send({ id, error: { code: -32602, message: `Invalid ${params.configId}` } });
    }
    // Setting a model without Auto mode support makes the real adapter print a notice before any prompt.
    if (params.configId === 'model' && script.autoModeNotice) {
      update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '\n\n> **Auto mode unavailable:** the selected model does not support Auto mode.\n\n',
        },
      });
    }
    return send({ id, result: { configOptions: [{ id: params.configId, currentValue: params.value, options: [] }] } });
  }
  if (method === 'session/cancel') {
    cancelled = true;
    wake?.();
    return undefined;
  }
  if (method === 'session/prompt') {
    if (!known) return send({ id, error: { code: -32002, message: 'Resource not found' } });
    const steps = script.prompts ?? [{ updates: [{ text: 'ok' }] }];
    const step = steps[Math.min(promptCount, steps.length - 1)];
    promptCount += 1;
    cancelled = false;
    if (step.crash) {
      for (const item of step.updates ?? []) emitUpdate(params.sessionId, item);
      process.exit(step.crash === true ? 1 : step.crash);
    }
    for (const item of step.updates ?? []) {
      emitUpdate(params.sessionId, item);
      if (step.pauseMs) await sleep(step.pauseMs);
    }
    if (step.permission) {
      const answer = await clientRequest('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: step.permission.toolCall,
        options: step.permission.options ?? [
          { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
          { optionId: 'allow-with-updates', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject', name: 'No', kind: 'reject_once' },
        ],
      });
      record({ type: 'permission-answer', answer });
    }
    if (step.elicitation) {
      const answer = await clientRequest('elicitation/create', {
        mode: 'form',
        sessionId: params.sessionId,
        message: step.elicitation.message ?? 'Which color?',
        requestedSchema: step.elicitation.requestedSchema ?? { type: 'object', properties: {} },
      });
      record({ type: 'elicitation-answer', answer });
    }
    if (step.waitForCancel) {
      await new Promise((resolve) => {
        wake = resolve;
        if (cancelled) resolve();
      });
      return send({ id, result: { stopReason: 'cancelled' } });
    }
    if (step.hang) return undefined;
    if (step.error) return send({ id, error: step.error });
    send({ id, result: { stopReason: step.stopReason ?? 'end_turn', usage: {}, _meta: {} } });
    // Native timers: updates that arrive when no prompt is in flight, with no start or end marker.
    if (step.unprompted) {
      await sleep(step.unprompted.afterMs ?? 20);
      for (const item of step.unprompted.updates) emitUpdate(params.sessionId, item);
    }
    return undefined;
  }
  if (id !== undefined && method !== undefined) {
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  return undefined;
}

function emitUpdate(sid, item) {
  if (item.text !== undefined) {
    return update(sid, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: item.text },
      messageId: 'msg_1',
    });
  }
  return update(sid, item);
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
    const message = JSON.parse(line);
    record({ type: 'in', message });
    if (message.id !== undefined && message.method === undefined && clientPending.has(message.id)) {
      const resolve = clientPending.get(message.id);
      clientPending.delete(message.id);
      resolve(message.result ?? message.error);
      continue;
    }
    void handle(message);
  }
});
process.stdin.on('end', () => {
  if (!script.ignoreStdinEnd) process.exit(0);
});
if (script.ignoreStdinEnd) setInterval(() => {}, 1000);
