#!/usr/bin/env node
// Runs the dashboard and the worker together: `npm start`, or `npm run dev` (argument "dev").
// Not concurrently: on Ctrl-C it tree-kills each command, which also signals Copilot (a child of the worker),
// and `-k` sends the worker a second signal. Here a signal is passed to the two direct children only, and the
// worker treats signals that arrive within a second as one Ctrl-C, so it waits for the active Run.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createProcessSupervisor } from './processSupervisor.mjs';

const dev = process.argv[2] === 'dev';
const port = process.env.PORT ?? (dev ? '3000' : '4317');
const commands = {
  web: ['next', dev ? 'dev' : 'start', '-H', '127.0.0.1', '-p', port],
  // Plain node with the tsx loader: the tsx CLI relays signals and SIGKILLs a child when several arrive at once.
  worker: ['node', ...(dev ? ['--watch'] : []), '--import', 'tsx', 'src/worker/main.ts'],
};

const env = { ...process.env, PATH: `${path.resolve('node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}` };
const supervisor = createProcessSupervisor({
  spawn,
  commands,
  env,
  exit: (code) => process.exit(code),
  log: (message) => console.error(message),
});
supervisor.start();

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => supervisor.stop(signal));
}
