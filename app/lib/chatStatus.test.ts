import { expect, test } from 'vitest';
import type { RunRow } from '@core/index';
import { chatStatus } from './chatStatus';

const run = (overrides: Partial<RunRow>): RunRow =>
  ({
    status: 'finished',
    outcome: null,
    resultStatus: null,
    interrupted: null,
    closedAt: null,
    chatState: null,
    ...overrides,
  }) as RunRow;

test('Waiting for you wins over every other state of the Chat', () => {
  expect(chatStatus(run({ chatState: 'waiting', status: 'running' }))).toBe('waiting');
  expect(chatStatus(run({ chatState: 'waiting', outcome: 'done' }))).toBe('waiting');
  expect(chatStatus(run({ chatState: 'waiting', interrupted: 'worker-restart', resultStatus: 'error' }))).toBe(
    'waiting',
  );
});

test('other states are unchanged', () => {
  expect(chatStatus(run({ outcome: 'needs-you' }))).toBe('needs-you');
  expect(chatStatus(run({ resultStatus: 'error' }))).toBe('error');
  expect(chatStatus(run({ status: 'running' }))).toBe('running');
  expect(chatStatus(run({ status: 'queued' }))).toBe('queued');
  expect(chatStatus(run({ outcome: 'done', chatState: 'idle' }))).toBeNull();
  expect(chatStatus(run({ closedAt: 5, outcome: 'needs-you' }))).toBeNull();
  expect(chatStatus(run({ interrupted: 'timeout' }))).toBeNull();
});
