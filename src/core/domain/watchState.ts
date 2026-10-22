import type { WatchState } from './types';

export type WatchAction = 'pause' | 'resume' | 'resumeRunNow' | 'close' | 'reopen' | 'runNow' | 'delete';

const ACTIONS: readonly WatchAction[] = ['pause', 'resume', 'resumeRunNow', 'close', 'reopen', 'runNow', 'delete'];

// Missing entries are invalid. runNow/delete keep the state; WatchService handles enqueueing and the running-Run check.
const TRANSITIONS: Record<WatchState, Partial<Record<WatchAction, WatchState>>> = {
  active: { pause: 'paused', close: 'closed', runNow: 'active', delete: 'active' },
  paused: { resume: 'active', close: 'closed', runNow: 'paused', delete: 'paused' },
  needs_you: { pause: 'paused', resume: 'active', resumeRunNow: 'active', close: 'closed', delete: 'needs_you' },
  closed: { reopen: 'active', delete: 'closed' },
};

export function nextState(state: WatchState, action: WatchAction): WatchState | null {
  return TRANSITIONS[state][action] ?? null;
}

export function allowedActions(state: WatchState): WatchAction[] {
  return ACTIONS.filter((a) => nextState(state, a) !== null);
}
