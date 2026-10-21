import { heartbeat, type Core } from '@core/index';

const ts = () => new Date().toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class WorkerLoop {
  private readonly tickMs: number;
  private readonly schedulerEveryMs: number;
  private lastSchedulerAt: number | null = null;
  private readonly onLockLost: () => void;
  private active: Promise<void> | null = null;
  private ticking: Promise<void> | null = null;
  private current: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;

  constructor(
    private readonly core: Core,
    opts: { tickMs?: number; schedulerEveryMs?: number; onLockLost?: () => void } = {},
  ) {
    this.tickMs = opts.tickMs ?? 1000;
    this.schedulerEveryMs = opts.schedulerEveryMs ?? 30_000;
    this.onLockLost = opts.onLockLost ?? (() => {});
  }

  async iterate(): Promise<void> {
    const { core } = this;
    const now = core.deps.clock.now();
    const held = this.guard('heartbeat', () => heartbeat(core.db, core.deps.clock, process.pid));
    if (held === false && !this.stopping) {
      console.error(`${ts()} lost worker lock; exiting`);
      this.stopping = true;
      this.onLockLost();
    }
    this.guard('watchdog', () => core.executor.watchdog());
    if (this.stopping) return;

    if (!core.executor.isBusy()) {
      const run = this.guard('claim', () => core.queue.claimNext());
      if (run) this.track(core.executor.execute(run).then(() => undefined));
    }

    // The tick runs in the background so slow pre-checks never stall the heartbeat or the watchdog.
    if (this.ticking === null && (this.lastSchedulerAt === null || now - this.lastSchedulerAt >= this.schedulerEveryMs)) {
      this.lastSchedulerAt = now;
      let started: Promise<unknown>;
      try {
        started = core.scheduler.tick();
      } catch (e) {
        started = Promise.reject(e);
      }
      const ticking: Promise<void> = started
        .then(
          () => undefined,
          (e: unknown) => console.error(`${ts()} scheduler tick failed: ${message(e)}`),
        )
        .finally(() => {
          if (this.ticking === ticking) this.ticking = null;
        });
      this.ticking = ticking;
    }

    this.guard('cleanup', () => {
      if (!core.cleanup.isDue()) return;
      const { deletedWatches, deletedAttempts } = core.cleanup.run();
      console.log(`${ts()} cleanup removed ${deletedWatches} watches and ${deletedAttempts} attempt files`);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const tick = () => {
      this.timer = null;
      this.current = this.iterate().finally(() => {
        this.current = null;
        if (this.started) this.timer = setTimeout(tick, this.tickMs);
      });
    };
    tick();
  }

  // Stops claiming and scheduling; keeps the watchdog ticking until the active Run and any pending tick end.
  async stop(): Promise<void> {
    this.stopping = true;
    await this.current;
    if (this.active !== null) await this.active;
    if (this.ticking !== null) await this.ticking;
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private track(execution: Promise<void>): void {
    const active: Promise<void> = execution
      .catch((e: unknown) => console.error(`${ts()} run execution failed: ${message(e)}`))
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    this.active = active;
  }

  private guard<T>(step: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      console.error(`${ts()} ${step} failed: ${message(e)}`);
      return undefined;
    }
  }
}
