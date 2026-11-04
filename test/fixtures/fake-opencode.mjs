#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? '';
const mode = process.env.FAKE_OPENCODE_MODE ?? 'success';
const sessionIndex = argv.indexOf('--session');
const sessionID = sessionIndex === -1 ? 'opencode-session-1' : argv[sessionIndex + 1];

if (process.env.FAKE_OPENCODE_RECORD) {
  fs.writeFileSync(process.env.FAKE_OPENCODE_RECORD, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
}

if (mode === 'auth-error' || mode === 'model-error') {
  const message =
    mode === 'auth-error'
      ? 'No authentication configured. Run opencode auth login.'
      : 'Unknown model: model-not-supported';
  process.stdout.write(`${JSON.stringify({ type: 'error', sessionID, error: { type: 'unknown', message } })}\n`);
  process.exit(1);
}
if (mode === 'execution-error') {
  process.stdout.write(
    `${JSON.stringify({
      type: 'error',
      sessionID,
      error: { type: 'unknown', message: 'Unexpected provider failure' },
    })}\n`,
  );
  process.exit(2);
}
if (mode === 'invalid-json') {
  process.stdout.write('not-json\n');
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    type: 'text',
    timestamp: Date.now(),
    sessionID,
    part: { type: 'text', text: 'OpenCode response' },
  })}\n`,
);

const resultPath = prompt.match(/write result to `([^`]+)`/)?.[1];
if (resultPath) fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'acted', summary: 'opencode done' }));
