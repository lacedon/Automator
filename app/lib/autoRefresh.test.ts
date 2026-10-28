import { expect, test } from 'vitest';
import type { ThreadView } from '@core/index';
import { keepsRefreshing } from './autoRefresh';

const threadOf = (...statuses: Array<'queued' | 'running' | 'finished'>) =>
  ({
    runs: statuses.map((status, id) => ({ id, status })),
    replyToRunId: null,
    replyBlockedReason: null,
  }) as unknown as ThreadView;

test('a Run without a thread refreshes until it finishes', () => {
  expect(keepsRefreshing('queued', null)).toBe(true);
  expect(keepsRefreshing('running', null)).toBe(true);
  expect(keepsRefreshing('finished', null)).toBe(false);
});

test('a finished Run keeps refreshing while a later Run in its thread is unfinished', () => {
  expect(keepsRefreshing('finished', threadOf('finished', 'queued'))).toBe(true);
  expect(keepsRefreshing('finished', threadOf('finished', 'running'))).toBe(true);
});

test('a fully finished thread stops refreshing', () => {
  expect(keepsRefreshing('finished', threadOf('finished', 'finished'))).toBe(false);
});

test('an unfinished Run refreshes even when its thread is finished', () => {
  expect(keepsRefreshing('running', threadOf('finished', 'finished'))).toBe(true);
});
