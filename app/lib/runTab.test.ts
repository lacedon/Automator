import { describe, expect, it } from 'vitest';
import { chatHref, initialRunTab } from './runTab';

describe('initialRunTab', () => {
  it('opens chat when requested and the Run has a thread', () => {
    expect(initialRunTab('chat', true)).toBe('chat');
  });
  it('falls back to transcript without a thread or for other values', () => {
    expect(initialRunTab('chat', false)).toBe('transcript');
    expect(initialRunTab(undefined, true)).toBe('transcript');
    expect(initialRunTab(['chat'], true)).toBe('transcript');
  });
  it('builds the redirect target of a new chat', () => {
    expect(chatHref(7)).toBe('/runs/7?tab=chat');
  });
});
