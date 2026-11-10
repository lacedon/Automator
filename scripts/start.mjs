#!/usr/bin/env node
// Runs the dashboard and the worker together: `npm start`, or `npm run dev` (argument "dev").
// Not concurrently: on Ctrl-C it tree-kills each command, which also signals Copilot (a child of the worker),
// and `-k` sends the worker a second signal. Here a signal is passed to the two direct children only, and the
// worker treats signals that arrive within a second as one Ctrl-C, so it waits for the active Run.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createProcessSupervisor } from './processSupervisor.mjs';

const dev = process.argv[2] === 'dev';
const port = process.env.PORT ?? (dev ? '3000' : '4317');
// Loopback by default; set HOST (for example 0.0.0.0) to serve a shared installation.
const host = process.env.HOST ?? '127.0.0.1';
// Next dev forks its server under the CLI, so use an inherited private IPC socket to reach this supervisor.
const restartSocketPath = dev
  ? process.platform === 'win32'
    ? `\\\\.\\pipe\\automator-supervisor-${process.pid}-${randomUUID()}`
    : `.automator-supervisor-${process.pid}-${randomUUID().replaceAll('-', '')}.sock`
  : undefined;
const commands = {
  web: ['next', dev ? 'dev' : 'start', '-H', host, '-p', port],
  // Plain node with the tsx loader: the tsx CLI relays signals and SIGKILLs a child when several arrive at once.
  worker: ['node', ...(dev ? ['--watch'] : []), '--import', 'tsx', 'src/worker/main.ts'],
};

const env = {
  ...process.env,
  PATH: `${path.resolve('node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
};
if (restartSocketPath === undefined) delete env.AUTOMATOR_SUPERVISOR_SOCKET;
else env.AUTOMATOR_SUPERVISOR_SOCKET = restartSocketPath;
const supervisor = createProcessSupervisor({
  spawn,
  commands,
  env,
  exit: (code) => process.exit(code),
  log: (message) => console.error(message),
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => supervisor.stop(signal));
}

await supervisor.start();
