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
  let fd: number | null = null;
  const fail = (error: unknown) => {
    failed ??= error instanceof Error ? error : new Error(String(error));
  };
  const close = () => {
    if (fd === null) return;
    const open = fd;
    fd = null;
    try {
      fs.closeSync(open);
    } catch (error) {
      fail(error);
    }
  };
  // A file left by an earlier attempt must never show up as this Run's output.
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    fail(error);
  }
  return {
    append(text) {
      if (failed !== null) return;
      try {
        if (fd === null) {
          // The first write creates the file afresh, then the fd stays open for the rest of the Run.
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fd = fs.openSync(file, 'w');
          fs.writeSync(fd, text);
        } else {
          fs.writeSync(fd, `${separator}${text}`);
        }
      } catch (error) {
        fail(error);
        close();
      }
    },
    finish(finalText) {
      close();
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

// Records a live-transcript write problem in the Run's log; it never changes the Run's result.
export function reportLiveFailure(live: LiveTranscript, logPath: string): void {
  if (live.failed === null) return;
  try {
    fs.appendFileSync(logPath, `live transcript write failed: ${live.failed.message}\n`);
  } catch {
    // The log is best effort.
  }
}

export type LineSplitterOptions = {
  // Lines longer than this are not delivered: onOversize gets their length instead and the memory is released.
  maxLineChars?: number;
  onOversize?: (chars: number) => void;
};

export function lineSplitter(
  onLine: (line: string) => void,
  options: LineSplitterOptions = {},
): { push(chunk: Buffer): void; end(): void } {
  const max = options.maxLineChars ?? Number.POSITIVE_INFINITY;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let skipping = false; // inside an oversized line, discarding until its newline
  let skipped = 0;
  const deliver = (line: string) => {
    if (line.length > max) options.onOversize?.(line.length);
    else onLine(line);
  };
  // Only the newly added text is scanned for newlines, so long newline-less output stays linear.
  const emit = (input: string, final: boolean) => {
    let text = input;
    if (skipping) {
      const nl = text.indexOf('\n');
      if (nl === -1) {
        skipped += text.length;
        if (final) options.onOversize?.(skipped);
        return;
      }
      options.onOversize?.(skipped + nl);
      skipping = false;
      text = text.slice(nl + 1);
    }
    const scanFrom = pending.length;
    pending += text;
    let start = 0;
    for (let nl = pending.indexOf('\n', scanFrom); nl !== -1; nl = pending.indexOf('\n', start)) {
      const end = nl > start && pending[nl - 1] === '\r' ? nl - 1 : nl;
      deliver(pending.slice(start, end));
      start = nl + 1;
    }
    pending = pending.slice(start);
    if (final && pending !== '') {
      deliver(pending.replace(/\r$/, ''));
      pending = '';
    } else if (pending.length > max) {
      skipping = true;
      skipped = pending.length;
      pending = '';
    }
  };
  return {
    push(chunk) {
      emit(decoder.write(chunk), false);
    },
    end() {
      emit(decoder.end(), true);
    },
  };
}
