import { describe, expect, test } from 'vitest';
import { timerPrompt } from '@core/index';
import { bubbleTranscript, timerRequestText } from './chatBubble';

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

describe('timerRequestText', () => {
  test('drops the wake-up header that core puts in front of the message', () => {
    const prompt = timerPrompt({ fireAt: 2, message: 'check <b>the build</b>\n\nthen reply', createdAt: 1 });
    expect(timerRequestText(prompt)).toBe('check <b>the build</b>\n\nthen reply');
    expect(timerRequestText('no header')).toBe('no header');
    expect(timerRequestText(null)).toBeNull();
  });
});
