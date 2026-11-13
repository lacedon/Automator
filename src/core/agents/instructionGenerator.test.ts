import { describe, expect, test, vi } from 'vitest';
import { generateAgentInstructions, INSTRUCTIONS_FILE } from './instructionGenerator';

describe('generateAgentInstructions', () => {
  test('generates from the instruction and the additional instructions', async () => {
    const task = vi.fn(async () => '  Detailed text\n');
    const result = await generateAgentInstructions('Review code', 'Be strict', task);
    expect(result).toEqual({ ok: true, value: 'Detailed text' });
    const [prompt, file] = task.mock.calls[0] as unknown as [string, string];
    expect(file).toBe(INSTRUCTIONS_FILE);
    expect(prompt).toContain('Review code');
    expect(prompt).toContain('Be strict');
  });

  test('still generates from the instruction alone, asking to close blind spots', async () => {
    const task = vi.fn(async () => 'Extended');
    expect((await generateAgentInstructions('Review code', '  ', task)).ok).toBe(true);
    expect((task.mock.calls[0] as unknown as [string])[0]).toContain('close blind spots');
  });

  test('generates from additional instructions alone', async () => {
    const task = vi.fn(async () => 'From extra');
    expect((await generateAgentInstructions('', 'Triage bugs', task)).ok).toBe(true);
  });

  test('errors without calling the agent when both fields are empty', async () => {
    const task = vi.fn(async () => 'x');
    const result = await generateAgentInstructions(' ', '', task);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(task).not.toHaveBeenCalled();
  });

  test('errors when the agent writes nothing', async () => {
    const result = await generateAgentInstructions('Review code', '', async () => null);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'instructions' } });
  });
});
