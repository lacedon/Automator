import type { Config } from '../config/schema';
import { isWithinWorkingHours, nextWindowStart } from '../domain/schedule';
import type { Run, Watch } from '../domain/types';

export type NextCheckKind =
  'in' | 'running' | 'queued' | 'after-hours' | 'stopped' | 'jira-off' | 'cleanup' | 'closed' | 'paused';
export type NextCheck = { kind: NextCheckKind; text: string; since?: number };

export interface NextCheckContext {
  now: number;
  running: Run | null;
  queuedPos: number | null;
  config: Config;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function inText(ms: number): string {
  if (ms < MINUTE) return 'in <1m';
  if (ms < HOUR) return `in ${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / DAY)}d`;
}

function windowText(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function nextCheckText(w: Watch, ctx: NextCheckContext): NextCheck {
  const { now, running, queuedPos, config } = ctx;
  if (running !== null && running.watchId === w.id)
    return { kind: 'running', text: 'running', since: running.startedAt ?? now };
  if (queuedPos !== null) return { kind: 'queued', text: `queued #${queuedPos}` };
  switch (w.state) {
    case 'needs_you':
      return { kind: 'stopped', text: 'stopped' };
    case 'paused':
      return { kind: 'paused', text: 'paused' };
    case 'closed': {
      if (!config.cleanup.enabled) return { kind: 'closed', text: 'closed' };
      const cleanupAt = (w.closedAt ?? now) + config.cleanup.retainClosedDays * DAY;
      return { kind: 'cleanup', text: `cleanup in ${Math.max(0, Math.ceil((cleanupAt - now) / DAY))}d` };
    }
    case 'active': {
      if (w.kind === 'jira' && !config.jira.enabled) return { kind: 'jira-off', text: 'Jira off' };
      const due = Math.max(w.nextCheckAt ?? now, now);
      const hours = config.schedule.workingHours;
      if (!isWithinWorkingHours(due, hours))
        return { kind: 'after-hours', text: `after hours · ${windowText(nextWindowStart(due, hours))}` };
      return { kind: 'in', text: inText(due - now) };
    }
  }
}
