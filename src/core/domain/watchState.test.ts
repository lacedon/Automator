import { describe, expect, it } from 'vitest';
import type { WatchState } from './types';
import { allowedActions, nextState, type WatchAction } from './watchState';

const cells: [WatchState, WatchAction, WatchState | null][] = [
  ['active', 'pause', 'paused'],
  ['active', 'resume', null],
  ['active', 'resumeRunNow', null],
  ['active', 'close', 'closed'],
  ['active', 'reopen', null],
  ['active', 'runNow', 'active'],
  ['active', 'delete', 'active'],
  ['paused', 'pause', null],
  ['paused', 'resume', 'active'],
  ['paused', 'resumeRunNow', null],
  ['paused', 'close', 'closed'],
  ['paused', 'reopen', null],
  ['paused', 'runNow', 'paused'],
  ['paused', 'delete', 'paused'],
  ['needs_you', 'pause', 'paused'],
  ['needs_you', 'resume', 'active'],
  ['needs_you', 'resumeRunNow', 'active'],
  ['needs_you', 'close', 'closed'],
  ['needs_you', 'reopen', null],
  ['needs_you', 'runNow', null],
  ['needs_you', 'delete', 'needs_you'],
  ['closed', 'pause', null],
  ['closed', 'resume', null],
  ['closed', 'resumeRunNow', null],
  ['closed', 'close', null],
  ['closed', 'reopen', 'active'],
  ['closed', 'runNow', null],
  ['closed', 'delete', 'closed'],
];

describe('nextState', () => {
  it('covers all 28 cells', () => { expect(cells).toHaveLength(28); });
  it.each(cells)('%s + %s → %s', (from, action, expected) => {
    expect(nextState(from, action)).toBe(expected);
  });
});

describe('allowedActions', () => {
  it.each([
    ['active', ['pause', 'close', 'runNow', 'delete']],
    ['paused', ['resume', 'close', 'runNow', 'delete']],
    ['needs_you', ['pause', 'resume', 'resumeRunNow', 'close', 'delete']],
    ['closed', ['reopen', 'delete']],
  ] as [WatchState, WatchAction[]][])('%s → %j', (state, expected) => {
    expect(allowedActions(state)).toEqual(expected);
  });
});
