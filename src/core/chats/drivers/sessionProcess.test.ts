import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createSessionLog, redactProtocolLine } from './sessionProcess';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('redactProtocolLine', () => {
  test('replaces email addresses and keeps the direction prefix', () => {
    expect(redactProtocolLine('< {"email":"person@example.com"}')).toBe('< {"email":"<redacted-email>"}');
    expect(redactProtocolLine('! mail from a.b+c@sub.example.co.uk failed')).toBe(
      '! mail from <redacted-email> failed',
    );
  });

  test('never logs an auth status payload', () => {
    const line = '< {"method":"auth/status_update","params":{"accounts":[{"label":"Pro","email":"p@example.com"}]}}';
    expect(redactProtocolLine(line)).toBe('< {"method":"auth/status_update","params":"(redacted)"}');
  });

  test('a 1 MB line is cut first and redacted in bounded time', () => {
    const hostile = [
      'a'.repeat(1_000_000),
      `${'a.'.repeat(500_000)}@`,
      `${'a@'.repeat(500_000)}`,
      `person@example.com ${'x'.repeat(1_000_000)}`,
    ];
    for (const line of hostile) {
      const started = performance.now();
      const out = redactProtocolLine(`< ${line}`);
      expect(performance.now() - started).toBeLessThan(100);
      expect(out.length).toBeLessThan(4_100);
      expect(out).toContain('(truncated)');
      expect(out).not.toContain('person@example.com');
    }
  });
});

describe('createSessionLog', () => {
  const file = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-log-'));
    dirs.push(dir);
    return path.join(dir, 'session.log');
  };

  test('stops appending at the size limit after one marker', () => {
    const logPath = file();
    const log = createSessionLog(logPath, 400);
    for (let i = 0; i < 100; i += 1) log(`< line ${i} ${'x'.repeat(20)}`);
    const text = fs.readFileSync(logPath, 'utf8');
    expect(text.length).toBeLessThanOrEqual(400 + 120);
    expect(text.match(/log limit/g)).toHaveLength(1);
    expect(text).toContain('line 0 ');
    expect(text).not.toContain('line 99 ');
  });

  test('counts what an earlier process already wrote', () => {
    const logPath = file();
    fs.writeFileSync(logPath, 'y'.repeat(390));
    const log = createSessionLog(logPath, 400);
    log('< more');
    log('< and more');
    expect(fs.readFileSync(logPath, 'utf8').match(/log limit/g)).toHaveLength(1);
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('and more');
  });
});
