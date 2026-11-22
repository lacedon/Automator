import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createLiveTranscript, lineSplitter } from './liveTranscript';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-transcript-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createLiveTranscript', () => {
  test('append makes text visible before finish', () => {
    const file = path.join(dir, 'run', 'transcript.md');
    const live = createLiveTranscript(file);
    live.append('first');
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(live.failed).toBeNull();
  });

  test('parts are joined with the separator exactly like the final transcript', () => {
    const file = path.join(dir, 'transcript.md');
    const live = createLiveTranscript(file, { separator: '\n' });
    const parts = ['one', 'two', 'three'];
    for (const part of parts) live.append(part);
    expect(fs.readFileSync(file, 'utf8')).toBe(parts.join('\n'));
  });

  test('the first append replaces a stale transcript file', () => {
    const file = path.join(dir, 'transcript.md');
    fs.writeFileSync(file, 'stale text from an earlier attempt');
    const live = createLiveTranscript(file);
    live.append('one');
    live.append('two');
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo');
  });

  test('a write failure is recorded and never thrown', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const live = createLiveTranscript(path.join(blocker, 'transcript.md'));
    expect(() => live.append('text')).not.toThrow();
    expect(live.failed).toBeInstanceOf(Error);
    expect(() => live.append('more')).not.toThrow();
    expect(() => live.finish('final')).not.toThrow();
  });

  test('finish replaces the live file atomically', () => {
    const file = path.join(dir, 'transcript.md');
    const live = createLiveTranscript(file);
    live.append('partial');
    live.finish('final text');
    expect(fs.readFileSync(file, 'utf8')).toBe('final text');
    expect(fs.readdirSync(dir)).toEqual(['transcript.md']);
  });

  test('finish with null keeps the live file', () => {
    const file = path.join(dir, 'transcript.md');
    const live = createLiveTranscript(file);
    live.append('partial');
    live.finish(null);
    expect(fs.readFileSync(file, 'utf8')).toBe('partial');
  });
});

describe('lineSplitter', () => {
  test('handles lines split across chunks and split multibyte characters', () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    const bytes = Buffer.from('héllo\r\nwörld €\nlast', 'utf8');
    for (let i = 0; i < bytes.length; i += 1) splitter.push(bytes.subarray(i, i + 1));
    expect(lines).toEqual(['héllo', 'wörld €']);
    splitter.end();
    expect(lines).toEqual(['héllo', 'wörld €', 'last']);
  });
});
