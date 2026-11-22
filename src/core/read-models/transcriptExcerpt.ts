import fs from 'node:fs';

export const TRANSCRIPT_EXCERPT_BYTES = 64 * 1024;

export type TranscriptExcerpt = { text: string; truncated: boolean };

// Reads the last `maxBytes` of the file synchronously, dropping a split leading UTF-8 sequence; null if absent/empty.
export function readTranscriptExcerpt(file: string, maxBytes = TRANSCRIPT_EXCERPT_BYTES): TranscriptExcerpt | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return null;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, size - length);
    let start = 0;
    const truncated = size > length;
    if (truncated) {
      // Skip UTF-8 continuation bytes (10xxxxxx) left over from a character cut by the window.
      while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start += 1;
    }
    const text = buffer.toString('utf8', start, bytesRead);
    return text === '' ? null : { text, truncated };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
