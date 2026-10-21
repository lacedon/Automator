import type { ReactNode } from 'react';
import type { RunRow } from '@core/index';

export type PillVariant = 'needs-you' | 'good' | 'running' | 'neutral' | 'paused' | 'closed' | 'info' | 'interrupted';

export function Pill({ variant, children }: { variant: PillVariant; children: ReactNode }) {
  return <span className={`pill pill-${variant}`}>{children}</span>;
}

const INTERRUPTED_LABEL = { timeout: 'timed out', cancelled: 'cancelled', 'worker-restart': 'interrupted' } as const;
const OUTCOME_VARIANT = { 'needs-you': 'needs-you', acted: 'good', nothing: 'neutral' } as const;

export function RunPill({ run }: { run: Pick<RunRow, 'status' | 'outcome' | 'resultStatus' | 'interrupted'> }) {
  if (run.interrupted !== null) return <Pill variant="interrupted">{INTERRUPTED_LABEL[run.interrupted]}</Pill>;
  if (run.resultStatus === 'error') return <Pill variant="needs-you">error</Pill>;
  if (run.outcome !== null) return <Pill variant={OUTCOME_VARIANT[run.outcome]}>{run.outcome}</Pill>;
  if (run.status === 'running') return <Pill variant="running">running</Pill>;
  if (run.status === 'queued') return <Pill variant="info">queued</Pill>;
  return <Pill variant="neutral">—</Pill>;
}
