#!/usr/bin/env node
// Runs the dashboard and the worker together: `npm start`, or `npm run dev` (argument "dev").
// Not concurrently: on Ctrl-C it tree-kills each command, which also signals Copilot (a child of the worker),
// and `-k` sends the worker a second signal. Here a signal is passed to the two direct children only, and the
// worker treats signals that arrive within a second as one Ctrl-C, so it waits for the active Run.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const dev = process.argv[2] === 'dev';
const port = process.env.PORT ?? (dev ? '3000' : '4317');
const commands = {
  web: ['next', dev ? 'dev' : 'start', '-H', '127.0.0.1', '-p', port],
  // Plain node with the tsx loader: the tsx CLI relays signals and SIGKILLs a child when several arrive at once.
  worker: ['node', ...(dev ? ['--watch'] : []), '--import', 'tsx', 'src/worker/main.ts'],
};

const env = { ...process.env, PATH: `${path.resolve('node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}` };
const children = new Map();
let stopping = false;
let exitCode = 0;

function signalAll(signal) {
  for (const child of children.values()) child.kill(signal);
}

for (const [name, [bin, ...args]] of Object.entries(commands)) {
  const child = spawn(bin, args, { stdio: 'inherit', env });
  children.set(name, child);
  child.on('error', (e) => console.error(`[start] ${name}: ${e.message}`));
  // 'close' also fires when the command can't be spawned at all.
  child.on('close', (code, signal) => {
    children.delete(name);
    if (!stopping) {
      // One process ended on its own (crash, lost worker lock): stop the other one too.
      stopping = true;
      exitCode = code || 1;
      console.error(`[start] ${name} exited (${signal ?? code}); stopping the rest`);
      signalAll('SIGTERM');
    } else if (name === 'worker' && code) {
      exitCode = code;
    }
    if (children.size === 0) process.exit(exitCode);
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    signalAll(signal);
  });
}
