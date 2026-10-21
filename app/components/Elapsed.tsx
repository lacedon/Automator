'use client';

import { formatElapsed } from '../lib/format';
import { useNow } from './useNow';

export function Elapsed({ since, limitMs }: { since: number; limitMs?: number }) {
  const now = useNow(1000);
  if (now === null) return <span className="elapsed">{limitMs === undefined ? '--:--' : `--:-- / ${formatElapsed(limitMs)}`}</span>;
  return <span className="elapsed">{formatElapsed(now - since, limitMs)}</span>;
}
