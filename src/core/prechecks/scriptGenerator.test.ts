import { describe, expect, test, vi } from 'vitest';
import { generatePrecheckScript, MAX_GENERATION_ATTEMPTS, REVIEW_FILE, SCRIPT_FILE } from './scriptGenerator';

const good = '#!/usr/bin/env bash\ncurl -s https://example.com/status\n';
const approve = JSON.stringify({ approved: true, reason: 'ok' });
const reject = JSON.stringify({ approved: false, reason: 'writes a file' });

function agent(replies: Record<string, (string | null)[]>) {
  return vi.fn(async (_prompt: string, file: string) => replies[file]!.shift() ?? null);
}

describe('generatePrecheckScript', () => {
  test('returns an approved script', async () => {
    const task = agent({ [SCRIPT_FILE]: [good], [REVIEW_FILE]: [approve] });
    expect(await generatePrecheckScript('watch status', task)).toEqual({ ok: true, value: good });
  });

  test('regenerates after a rejection and passes the reason on', async () => {
    const task = agent({ [SCRIPT_FILE]: [good, good], [REVIEW_FILE]: [reject, approve] });
    expect((await generatePrecheckScript('watch status', task)).ok).toBe(true);
    expect(task.mock.calls[2]![0]).toContain('writes a file');
  });

  test('skips the reviewer when the static deny-list fails', async () => {
    const task = agent({ [SCRIPT_FILE]: ['rm -rf x', good], [REVIEW_FILE]: [approve] });
    expect((await generatePrecheckScript('watch status', task)).ok).toBe(true);
    expect(task.mock.calls.filter(([, file]) => file === REVIEW_FILE)).toHaveLength(1);
  });

  test('gives up after 3 attempts with an error to change the instructions', async () => {
    const task = agent({ [SCRIPT_FILE]: [good, good, good, good], [REVIEW_FILE]: [reject, reject, reject, approve] });
    const result = await generatePrecheckScript('watch status', task);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'precheckInstructions' } });
    expect(task.mock.calls.filter(([, file]) => file === SCRIPT_FILE)).toHaveLength(MAX_GENERATION_ATTEMPTS);
  });
});
