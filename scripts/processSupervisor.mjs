import { chmodSync } from 'node:fs';
import { createServer } from 'node:net';

export function createProcessSupervisor({ spawn, commands, env, exit, log }) {
  const restartSocketPath = env.AUTOMATOR_SUPERVISOR_SOCKET;
  const children = new Map();
  const restartSockets = new Set();
  let restartServer;
  let stopping = false;
  let restarting = false;
  let restartAborted = false;
  let workerStopRequested = false;
  let webStopRequested = false;
  let started = false;
  let exitCode = 0;

  function signalAll(signal) {
    for (const child of children.values()) child.kill(signal);
  }

  function spawnChildren() {
    for (const [name, [bin, ...args]] of Object.entries(commands)) {
      const child = spawn(bin, args, {
        stdio: name === 'web' ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
        env,
      });
      children.set(name, child);
      child.on('error', (error) => {
        log(`[start] ${name}: ${error.message}`);
        if (restarting) restartAborted = true;
      });
      if (name === 'web') {
        child.on('message', (message = {}) =>
          handleRestartRequest(message, (acknowledgement) => child.send(acknowledgement)),
        );
      }
      child.on('close', (code, signal) => {
        if (children.get(name) === child) children.delete(name);

        if (restarting && !restartAborted) {
          if (name === 'worker' && workerStopRequested && code === 0 && signal === null) {
            webStopRequested = true;
            children.get('web')?.kill('SIGTERM');
            return;
          }
          if (name === 'web' && webStopRequested && (code === 0 || signal === 'SIGTERM')) {
            if (children.size === 0) {
              restarting = false;
              restartAborted = false;
              workerStopRequested = false;
              webStopRequested = false;
              spawnChildren();
            }
            return;
          }
          restarting = false;
        }

        if (!stopping) {
          stopping = true;
          exitCode = code || 1;
          log(`[start] ${name} exited (${signal ?? code}); stopping the rest`);
          signalAll('SIGTERM');
        } else if (name === 'worker' && code) {
          exitCode = code;
        }

        if (children.size === 0) exit(exitCode);
      });
    }
  }

  function handleRestartRequest({ type, requestId } = {}, acknowledge) {
    if (type !== 'restart') return;

    const accepted = !stopping && !restarting && !restartAborted;
    acknowledge({ type: accepted ? 'restart-accepted' : 'restart-rejected', requestId });
    if (!accepted) return;

    restarting = true;
    workerStopRequested = true;
    children.get('worker')?.kill('SIGTERM');
  }

  function startRestartServer() {
    restartServer = createServer((socket) => {
      restartSockets.add(socket);
      socket.setEncoding('utf8');
      socket.on('close', () => restartSockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          if (buffer.length > 4096) socket.destroy();
          return;
        }

        try {
          const request = JSON.parse(buffer.slice(0, newline));
          if (request.type !== 'restart' || typeof request.requestId !== 'string') {
            socket.destroy();
            return;
          }
          handleRestartRequest(request, (acknowledgement) => socket.end(`${JSON.stringify(acknowledgement)}\n`));
        } catch {
          socket.destroy();
        }
      });
    });

    return new Promise((resolve, reject) => {
      restartServer.once('error', reject);
      restartServer.listen(restartSocketPath, () => {
        restartServer.off('error', reject);
        restartServer.on('error', (error) => log(`[start] restart IPC: ${error.message}`));
        if (process.platform !== 'win32') chmodSync(restartSocketPath, 0o600);
        resolve();
      });
    });
  }

  function closeRestartServer() {
    if (!restartServer?.listening) return Promise.resolve();
    for (const socket of restartSockets) socket.destroy();
    return new Promise((resolve) => restartServer.close(resolve));
  }

  return {
    async start() {
      if (started || stopping) return;
      started = true;
      if (restartSocketPath !== undefined) await startRestartServer();
      if (stopping) {
        closeRestartServer();
        return;
      }
      spawnChildren();
    },
    stop(signal) {
      stopping = true;
      restarting = false;
      signalAll(signal);
      return closeRestartServer();
    },
  };
}
