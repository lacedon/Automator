export function createProcessSupervisor({ spawn, commands, env, exit, log }) {
  const children = new Map();
  let stopping = false;
  let restarting = false;
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
      child.on('error', (error) => log(`[start] ${name}: ${error.message}`));
      if (name === 'web') {
        child.on('message', ({ type, requestId } = {}) => {
          if (type !== 'restart') return;

          const accepted = !stopping && !restarting;
          child.send({ type: accepted ? 'restart-accepted' : 'restart-rejected', requestId });
          if (!accepted) return;

          restarting = true;
          children.get('worker')?.kill('SIGTERM');
        });
      }
      child.on('close', (code, signal) => {
        if (children.get(name) === child) children.delete(name);

        if (restarting) {
          if (name === 'worker') children.get('web')?.kill('SIGTERM');
          if (children.size === 0) {
            restarting = false;
            spawnChildren();
          }
          return;
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

  return {
    start() {
      if (started || stopping) return;
      started = true;
      spawnChildren();
    },
    stop(signal) {
      stopping = true;
      restarting = false;
      signalAll(signal);
    },
  };
}
