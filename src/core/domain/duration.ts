const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;
type Unit = keyof typeof UNIT_MS;

export function parseDuration(s: string): number {
  const match = /^(\d+)([smhd])$/.exec(s);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  return Number(match[1]) * UNIT_MS[match[2] as Unit];
}

export function formatDuration(ms: number): string {
  for (const unit of ['d', 'h', 'm'] as const) {
    if (ms !== 0 && ms % UNIT_MS[unit] === 0) return `${ms / UNIT_MS[unit]}${unit}`;
  }
  return `${Math.round(ms / UNIT_MS.s)}s`;
}
