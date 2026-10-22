export const DUPLICATE_SIGNAL_WINDOW_MS = 1000;

// One Ctrl-C can reach the worker several times (terminal, the start script, tsx relaying), so signals
// within the window count as one; a later signal is the user pressing Ctrl-C again to force exit.
export function createShutdownHandler(opts: {
  now(): number;
  onStop(signal: NodeJS.Signals): void;
  onForce(signal: NodeJS.Signals): void;
  windowMs?: number;
}): (signal: NodeJS.Signals) => void {
  const windowMs = opts.windowMs ?? DUPLICATE_SIGNAL_WINDOW_MS;
  let firstAt: number | null = null;
  return (signal) => {
    const now = opts.now();
    if (firstAt === null) {
      firstAt = now;
      opts.onStop(signal);
    } else if (now - firstAt >= windowMs) {
      opts.onForce(signal);
    }
  };
}
