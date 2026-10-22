import type { ReactNode } from 'react';
import type { NextCheck, RunRow, WatchState } from '@core/index';
import { Elapsed } from './Elapsed';

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

const STATE_PILL: Record<WatchState, { variant: PillVariant; label: string }> = {
  needs_you: { variant: 'needs-you', label: 'Needs you' },
  active: { variant: 'good', label: 'Active' },
  paused: { variant: 'paused', label: 'Paused' },
  closed: { variant: 'closed', label: 'Closed' },
};

export function WatchStatePill({ state }: { state: WatchState }) {
  const { variant, label } = STATE_PILL[state];
  return <Pill variant={variant}>{label}</Pill>;
}

export function NextCheckLabel({ next }: { next: NextCheck }) {
  if (next.kind === 'running' && next.since !== undefined) {
    return (
      <Pill variant="running">
        ● running <Elapsed since={next.since} />
      </Pill>
    );
  }
  if (next.kind === 'in' || next.kind === 'queued') return <>{next.text}</>;
  if (next.kind === 'after-hours') {
    const [head, window] = next.text.split(' · ');
    return (
      <>
        {head} <span className="muted">· {window}</span>
      </>
    );
  }
  return <span className="muted">{next.text}</span>;
}
