import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { writeTextAtomic } from '../files/atomic';

export interface LiveTranscript {
  // Appends one text part; parts after the first are preceded by the separator so the live file equals
  // the launcher's final `parts.join(separator)`. Never throws: the first write error is kept in `failed`
  // and later appends are skipped.
  append(text: string): void;
  // Atomically replaces the file with the launcher's final normalized transcript (today's behaviour).
  // `null` leaves the live file as it is.
  finish(finalText: string | null): void;
  readonly failed: Error | null;
}

export function createLiveTranscript(file: string, options: { separator?: string } = {}): LiveTranscript {
  const separator = options.separator ?? '\n';
  let failed: Error | null = null;
  let parts = 0;
  const fail = (error: unknown) => {
    failed ??= error instanceof Error ? error : new Error(String(error));
  };
  return {
    append(text) {
      if (failed !== null) return;
      try {
        if (parts === 0) {
          // The first write replaces any stale file so the live file always equals the joined parts.
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, text);
        } else {
          fs.appendFileSync(file, `${separator}${text}`);
        }
        parts += 1;
      } catch (error) {
        fail(error);
      }
    },
    finish(finalText) {
      if (finalText === null) return;
      try {
        writeTextAtomic(file, finalText);
      } catch (error) {
        fail(error);
      }
    },
    get failed() {
      return failed;
    },
  };
}

export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const drain = (final: boolean) => {
    const lines = pending.split(/\r?\n/);
    pending = final ? '' : (lines.pop() ?? '');
    for (const line of lines) onLine(line);
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      drain(false);
    },
    end() {
      pending += decoder.end();
      if (pending !== '') drain(true);
    },
  };
}
