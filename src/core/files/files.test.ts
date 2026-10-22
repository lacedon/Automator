import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { writeJsonAtomic, writeTextAtomic } from './atomic';
import { writeAttemptError } from './attempts';
import { DataDir } from './dataDir';

const tempRoot = path.resolve('test-results', 'tmp');
const cleanups: string[] = [];

function tempDir(): string {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'files-'));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('lays out run files under the data dir', () => {
  const root = tempDir();
  const d = new DataDir(root);
  expect(d.db).toBe(path.join(root, 'automator.db'));
  expect(d.attemptsDir).toBe(path.join(root, 'attempts'));
  expect(d.runDir(7)).toBe(path.join(root, 'runs', '7'));
  expect(d.promptPath(7)).toBe(path.join(root, 'runs', '7', 'prompt.md'));
  expect(d.transcriptPath(7)).toBe(path.join(root, 'runs', '7', 'transcript.md'));
  expect(d.copilotResultPath(7)).toBe(path.join(root, 'runs', '7', 'copilot-result.json'));
  expect(d.resultPath(7)).toBe(path.join(root, 'runs', '7', 'result.json'));
  expect(d.cliLogPath(7)).toBe(path.join(root, 'runs', '7', 'cli.log'));
});

test('ensures and removes run dirs', () => {
  const d = new DataDir(tempDir());
  expect(d.ensureRunDir(3)).toBe(d.runDir(3));
  expect(fs.statSync(d.runDir(3)).isDirectory()).toBe(true);
  fs.writeFileSync(d.cliLogPath(3), 'log');
  d.removeRunDir(3);
  expect(fs.existsSync(d.runDir(3))).toBe(false);
  expect(() => d.removeRunDir(3)).not.toThrow();
});

test('writes json atomically and leaves no tmp file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'result.json');
  writeJsonAtomic(file, { schemaVersion: 1, a: [1] });
  expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "schemaVersion": 1,\n  "a": [\n    1\n  ]\n}\n');
  writeJsonAtomic(file, { b: 2 });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ b: 2 });
  writeTextAtomic(path.join(dir, 'nested', 'prompt.md'), 'hello');
  expect(fs.readFileSync(path.join(dir, 'nested', 'prompt.md'), 'utf8')).toBe('hello');
  expect(fs.readdirSync(path.join(dir, 'nested')).sort()).toEqual(['prompt.md', 'result.json']);
});

test('attempt file contains schemaVersion 1 and error', () => {
  const d = new DataDir(tempDir());
  const now = Date.parse('2026-10-21T10:00:00.000Z');
  const r = writeAttemptError(d, { code: 'INVALID_TARGET', input: 'x' }, now);
  expect(r.writeError).toBeUndefined();
  expect(r.path).not.toBeNull();
  const file = r.path as string;
  expect(path.dirname(file)).toBe(d.attemptsDir);
  expect(path.basename(file)).toMatch(/^2026-10-21T10-00-00\.000Z-[0-9a-f-]{36}\.json$/);
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  expect(body).toEqual({
    schemaVersion: 1,
    attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    at: '2026-10-21T10:00:00.000Z',
    status: 'error',
    error: { code: 'INVALID_TARGET', input: 'x' },
  });
  expect(path.basename(file)).toContain(body.attemptId as string);
});

test('attempt write failure returns null path and message', () => {
  const d = new DataDir(tempDir());
  fs.writeFileSync(d.attemptsDir, 'not a dir');
  const r = writeAttemptError(d, { code: 'X' }, Date.now());
  expect(r.path).toBeNull();
  expect(r.writeError).toEqual(expect.any(String));
  expect(r.writeError).not.toBe('');
});

test('isInside rejects ../ traversal', () => {
  const root = tempDir();
  const d = new DataDir(root);
  expect(d.isInside(path.join(root, 'runs', '1', 'cli.log'))).toBe(true);
  expect(d.isInside(`${root}/runs/../automator.db`)).toBe(true);
  expect(d.isInside(`${root}/runs/../../escape`)).toBe(false);
  expect(d.isInside(`${root}/../${path.basename(root)}-sibling/x`)).toBe(false);
  expect(d.isInside(`${root}-sibling`)).toBe(false);
  expect(d.isInside(root)).toBe(false);
  expect(d.isInside('/etc/passwd')).toBe(false);
  expect(d.isInside(path.join(root, '..notes'))).toBe(true);
});
