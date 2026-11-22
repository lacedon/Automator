import { expect, test } from 'vitest';
import { INTERACTIVE_CAPABILITIES } from './capabilities';

test('verified providers get the Automator tools and native question mapping from the spike table', () => {
  expect(INTERACTIVE_CAPABILITIES['claude-code']).toMatchObject({
    interactive: true,
    automatorTools: 'mcp',
    nativeQuestions: 'acp-elicitation',
  });
  expect(INTERACTIVE_CAPABILITIES.pi).toMatchObject({
    interactive: true,
    automatorTools: 'pi-extension',
    nativeQuestions: 'pi-extension-ui',
  });
});

test('gated-off providers have no tools and no native questions', () => {
  for (const provider of ['copilot', 'codex', 'opencode'] as const) {
    expect(INTERACTIVE_CAPABILITIES[provider]).toMatchObject({
      interactive: false,
      automatorTools: 'none',
      nativeQuestions: 'none',
    });
  }
});

test('only Claude Code has native timers that fire unprompted turns', () => {
  expect(INTERACTIVE_CAPABILITIES['claude-code'].nativeTimers).toBe(true);
  for (const provider of ['pi', 'copilot', 'codex', 'opencode'] as const) {
    expect(INTERACTIVE_CAPABILITIES[provider].nativeTimers).toBe(false);
  }
});
