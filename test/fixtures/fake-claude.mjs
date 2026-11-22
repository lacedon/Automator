#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const prompt = argValue('-p') ?? '';
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';

if (process.env.FAKE_CLAUDE_RECORD) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
}

if (mode === 'auth-error') {
  process.stderr.write('Authentication failed. Run claude auth login.\n');
  process.exit(1);
}
if (mode === 'model-error') {
  process.stderr.write('Unknown model: model-not-supported\n');
  process.exit(1);
}
if (mode === 'execution-error') {
  process.stderr.write('Unexpected provider failure\n');
  process.exit(2);
}

const sessionId = argValue('--resume') ?? 'claude-session-1';
if (mode !== 'missing-session') {
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`);
}
if (mode === 'stream-wait') {
  process.stdout.write(
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'First part' }] } })}\n`,
  );
  const release = process.env.FAKE_CLAUDE_RELEASE;
  const waitDeadline = Date.now() + 15_000;
  while (release && !fs.existsSync(release)) {
    // A test that never releases must not leak a spinning child.
    if (Date.now() > waitDeadline) process.exit(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
process.stdout.write(
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Assistant output' }] } })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    result: 'Assistant output',
    ...(mode === 'missing-session' ? {} : { session_id: sessionId }),
  })}\n`,
);

const resultPath = prompt.match(/write result to `([^`]+)`/)?.[1];
if (resultPath) fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'acted', summary: 'done' }));
