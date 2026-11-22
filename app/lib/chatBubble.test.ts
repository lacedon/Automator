import { describe, expect, test } from 'vitest';
import { bubbleTranscript } from './chatBubble';

describe('bubbleTranscript', () => {
  test('bubble shows transcript text as-is', () => {
    expect(bubbleTranscript({ transcript: { text: '**raw** <b>text</b>\n', truncated: false } })).toBe(
      '**raw** <b>text</b>\n',
    );
    expect(bubbleTranscript({ transcript: null })).toBeNull();
  });

  // The Copilot spike (does the --share export start with the prompt?) could not be run, so nothing is dropped.
  test('Copilot share text passes through unchanged', () => {
    const text = '# Copilot session\n\n> Do the thing\n\nAnswer';
    expect(bubbleTranscript({ transcript: { text, truncated: false } })).toBe(text);
  });
});
