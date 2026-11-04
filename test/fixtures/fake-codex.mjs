#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? '';
const mode = process.env.FAKE_CODEX_MODE ?? 'success';
const resumeIndex = argv.indexOf('resume');
const sessionId = resumeIndex === -1 ? 'codex-thread-1' : argv[resumeIndex + 1];

if (process.env.FAKE_CODEX_RECORD) {
  fs.writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
}

if (mode === 'auth-error') {
  process.stderr.write('Authentication required. Run codex login.\n');
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
if (mode === 'invalid-json') {
  process.stdout.write('not-json\n');
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
process.stdout.write(
  `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex response' } })}\n`,
);
process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);

const resultPath = prompt.match(/write result to `([^`]+)`/)?.[1];
if (resultPath) fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'acted', summary: 'codex done' }));
