'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Current time rounded to tickMs; null during SSR and hydration so server and client markup match.
export function useNow(tickMs: number): number | null {
  const subscribe = useCallback(
    (onTick: () => void) => {
      const timer = setInterval(onTick, tickMs);
      return () => clearInterval(timer);
    },
    [tickMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / tickMs) * tickMs,
    () => null,
  );
}
