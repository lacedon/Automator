import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { NextCheck, RunRow, Trigger, WatchState } from '@core/index';
import { Elapsed } from './Elapsed';

export type PillVariant = 'needs-you' | 'good' | 'running' | 'neutral' | 'paused' | 'closed' | 'info' | 'interrupted';

export function Pill({ variant, children }: { variant: PillVariant; children: ReactNode }) {
  return <span className={`pill pill-${variant}`}>{children}</span>;
}

const OUTCOME_VARIANT = { 'needs-you': 'needs-you', acted: 'good', nothing: 'neutral' } as const;

// Manual and ad-hoc requests jump the queue (Info); scheduled ones wait their turn (Neutral).
function queuedVariant(trigger: Trigger | undefined): PillVariant {
  return trigger === 'schedule' ? 'neutral' : 'info';
}

export function PriorityPill({ trigger }: { trigger: Trigger }) {
  const t = useTranslations('Trigger');
  return <Pill variant={queuedVariant(trigger)}>{t(trigger)}</Pill>;
}

type RunPillRun = Pick<RunRow, 'status' | 'outcome' | 'resultStatus' | 'interrupted'> &
  Partial<Pick<RunRow, 'trigger' | 'closedAt'>>;

export function RunPill({ run }: { run: RunPillRun }) {
  const t = useTranslations('Pill');
  if (run.closedAt != null) return <Pill variant="closed">{t('done')}</Pill>;
  if (run.interrupted !== null) return <Pill variant="interrupted">{t(run.interrupted)}</Pill>;
  if (run.resultStatus === 'error') return <Pill variant="needs-you">{t('error')}</Pill>;
  if (run.outcome !== null) return <Pill variant={OUTCOME_VARIANT[run.outcome]}>{t(run.outcome)}</Pill>;
  if (run.status === 'running') return <Pill variant="running">{t('running')}</Pill>;
  if (run.status === 'queued') return <Pill variant={queuedVariant(run.trigger)}>{t('queued')}</Pill>;
  return <Pill variant="neutral">—</Pill>;
}

const STATE_PILL: Record<WatchState, PillVariant> = {
  needs_you: 'needs-you',
  active: 'good',
  paused: 'paused',
  closed: 'closed',
};

export function WatchStatePill({ state }: { state: WatchState }) {
  const t = useTranslations('Pill');
  return <Pill variant={STATE_PILL[state]}>{t(`state_${state}`)}</Pill>;
}

export function NextCheckLabel({ next }: { next: NextCheck }) {
  const t = useTranslations('Pill');
  if (next.kind === 'running' && next.since !== undefined) {
    return (
      <Pill variant="running">
        ● {t('running')} <Elapsed since={next.since} />
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
