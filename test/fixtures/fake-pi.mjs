#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? '';
const mode = process.env.FAKE_PI_MODE ?? 'success';
const sessionIndex = argv.indexOf('--session');
const sessionID = sessionIndex === -1 ? 'pi-session-1' : argv[sessionIndex + 1];

if (process.env.FAKE_PI_RECORD) {
  fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (extra) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'pi response' }], ...extra },
});

if (mode === 'invalid-json') {
  process.stdout.write('not-json\n');
  process.exit(0);
}
if (mode === 'auth-error' || mode === 'model-error') {
  process.stderr.write(
    mode === 'auth-error' ? 'No credentials. Run pi auth login anthropic.\n' : 'Unknown model: model-not-supported\n',
  );
  process.exit(1);
}

emit({ type: 'session', version: 3, id: sessionID, cwd: process.cwd() });
emit({ type: 'agent_start' });
emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
if (mode === 'execution-error') {
  emit(assistant({ content: [], stopReason: 'error', errorMessage: 'Unexpected provider failure' }));
  process.exit(0);
}
if (mode === 'stream-wait') {
  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'First part' }], stopReason: 'toolUse' },
  });
  const release = process.env.FAKE_PI_RELEASE;
  while (release && !fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20));
}
emit(assistant({ stopReason: 'stop' }));
emit({ type: 'agent_settled', aborted: false });

const resultPath = prompt.match(/write result to `([^`]+)`/)?.[1];
if (resultPath) fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'acted', summary: 'pi done' }));
