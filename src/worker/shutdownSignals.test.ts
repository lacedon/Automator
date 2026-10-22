import { describe, expect, test, vi } from 'vitest';
import { createShutdownHandler } from './shutdownSignals';

function setup() {
  let now = 0;
  const onStop = vi.fn();
  const onForce = vi.fn();
  const handle = createShutdownHandler({ now: () => now, onStop, onForce, windowMs: 1000 });
  return { handle, onStop, onForce, advance: (ms: number) => (now += ms) };
}

describe('createShutdownHandler', () => {
  test('signals within the window count as one Ctrl-C', () => {
    const s = setup();
    s.handle('SIGINT');
    s.advance(10);
    s.handle('SIGINT');
    s.advance(500);
    s.handle('SIGTERM');
    s.advance(489);
    s.handle('SIGTERM');
    expect(s.onStop).toHaveBeenCalledTimes(1);
    expect(s.onStop).toHaveBeenCalledWith('SIGINT');
    expect(s.onForce).not.toHaveBeenCalled();
  });

  test('a signal after the window forces exit', () => {
    const s = setup();
    s.handle('SIGTERM');
    s.advance(1000);
    s.handle('SIGINT');
    expect(s.onStop).toHaveBeenCalledTimes(1);
    expect(s.onForce).toHaveBeenCalledWith('SIGINT');
  });
});
