#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const prompt = argValue('-p') ?? '';
const sharePath = argValue('--share');
const mode = process.env.FAKE_COPILOT_MODE ?? 'nothing';
const resultPath = prompt.match(/write exactly this JSON to `([^`]+)`/)?.[1];

if (process.env.FAKE_COPILOT_RECORD) {
  fs.writeFileSync(process.env.FAKE_COPILOT_RECORD, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
}

if (mode === 'hang') {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  if (process.env.FAKE_COPILOT_CHILD_PID_FILE) {
    fs.writeFileSync(process.env.FAKE_COPILOT_CHILD_PID_FILE, String(child.pid));
  }
  setInterval(() => {}, 1 << 30);
} else {
  if (sharePath) fs.writeFileSync(sharePath, `# fake transcript\n${mode}\n`);

  const writeResult = (content) => {
    if (resultPath) fs.writeFileSync(resultPath, content);
  };

  switch (mode) {
    case 'acted':
    case 'nothing':
    case 'needs-you':
      writeResult(JSON.stringify({ outcome: mode, summary: `fake ${mode}` }));
      break;
    case 'invalid-json':
      writeResult('not json');
      break;
    case 'long-summary':
      writeResult(JSON.stringify({ outcome: 'acted', summary: 'x'.repeat(800), extra: true }));
      break;
    case 'no-result':
    case 'exit-1':
      break;
    default:
      process.stderr.write(`fake-copilot: unknown mode ${mode}\n`);
      process.exit(2);
  }

  process.exit(mode === 'exit-1' ? 1 : 0);
}
