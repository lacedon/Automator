import {
  acquireWorkerLock,
  bootstrap,
  isProcessAlive,
  recoverInterruptedRuns,
  releaseWorkerLock,
  resolveJiraDoneNames,
} from '@core/index';
import { WorkerLoop } from './loop';

const ts = () => new Date().toISOString();

async function main(): Promise<void> {
  const core = bootstrap();
  const { pid } = process;
  const lock = acquireWorkerLock(core.db, core.deps.clock, pid, isProcessAlive);
  if (!lock.ok) {
    console.error(`Another worker is running (pid ${lock.error.pid})`);
    core.close();
    process.exit(1);
  }

  const loop = new WorkerLoop(core);
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.log(`${ts()} ${signal} again, exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`${ts()} ${signal} received, waiting for the active run to finish`);
    void loop
      .stop()
      .catch((e: unknown) => console.error(`${ts()} shutdown failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        releaseWorkerLock(core.db, pid);
        core.close();
        console.log(`${ts()} worker stopped`);
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const recovered = await recoverInterruptedRuns(core.executorDeps);
  if (recovered > 0) console.log(`${ts()} recovered ${recovered} interrupted run(s)`);
  if (core.config.jira.enabled) await resolveJiraDoneNames(core);

  if (!shuttingDown) loop.start();
  console.log(`${ts()} worker started (pid ${pid})`);
}

main().catch((e: unknown) => {
  console.error(`${ts()} worker failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
