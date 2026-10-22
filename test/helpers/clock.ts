import type { Clock } from '../../src/core/domain/types';

export function fakeClock(
  start = Date.parse('2026-10-21T10:00:00'),
): Clock & { set(t: number): void; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    set(next) {
      t = next;
    },
    advance(ms) {
      t += ms;
    },
  };
}
