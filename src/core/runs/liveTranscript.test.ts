import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLiveTranscript, lineSplitter, reportLiveFailure } from './liveTranscript';

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

  test('a stale transcript file is removed even when nothing is appended', () => {
    const file = path.join(dir, 'transcript.md');
    fs.writeFileSync(file, 'stale');
    const live = createLiveTranscript(file);
    live.finish(null);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('writes after the first reuse one file descriptor and finish releases it', () => {
    const file = path.join(dir, 'transcript.md');
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    try {
      const live = createLiveTranscript(file);
      for (const part of ['a', 'b', 'c']) live.append(part);
      expect(open).toHaveBeenCalledTimes(1);
      live.finish(null);
      expect(close).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\nc');
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  test('reportLiveFailure logs the failure and stays silent otherwise', () => {
    const log = path.join(dir, 'run.log');
    reportLiveFailure(createLiveTranscript(path.join(dir, 'ok.md')), log);
    expect(fs.existsSync(log)).toBe(false);

    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const live = createLiveTranscript(path.join(blocker, 'transcript.md'));
    live.append('text');
    reportLiveFailure(live, log);
    expect(fs.readFileSync(log, 'utf8')).toMatch(/^live transcript write failed: .+\n$/);
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

describe('lineSplitter line limit', () => {
  test('lines over the limit are reported instead of delivered, across chunks, and later lines survive', () => {
    const lines: string[] = [];
    const oversized: number[] = [];
    const splitter = lineSplitter((line) => lines.push(line), {
      maxLineChars: 10,
      onOversize: (chars) => oversized.push(chars),
    });
    splitter.push(Buffer.from('ok\n'));
    splitter.push(Buffer.from('x'.repeat(8)));
    splitter.push(Buffer.from('x'.repeat(8))); // no newline yet: the partial line is dropped, not buffered
    splitter.push(Buffer.from('xx\nfine\n'));
    splitter.push(Buffer.from(`${'y'.repeat(30)}\nlast`));
    splitter.end();
    expect(lines).toEqual(['ok', 'fine', 'last']);
    expect(oversized).toEqual([18, 30]);
  });
});

describe('lineSplitter', () => {
  test('long newline-less output is handled in one pass and emitted at the end', () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    for (let i = 0; i < 2000; i += 1) splitter.push(Buffer.from('x'.repeat(1000)));
    expect(lines).toEqual([]);
    splitter.push(Buffer.from('\r\nnext\n'));
    expect(lines.map((line) => line.length)).toEqual([2_000_000, 4]);
  });

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
