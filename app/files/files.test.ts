import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DataDir } from '@core/index';

const core = vi.hoisted(() => ({ dataDir: null as unknown }));
vi.mock('../lib/core', () => ({ getCore: () => core }));

const { GET: getRunFile } = await import('./run/[id]/[name]/route');
const { GET: getAttemptFile } = await import('./attempt/[name]/route');

const tempRoot = path.resolve('test-results', 'tmp');
let root: string;
let dataDir: DataDir;

beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
  root = fs.mkdtempSync(path.join(tempRoot, 'files-route-'));
  dataDir = new DataDir(path.join(root, 'data'));
  core.dataDir = dataDir;
  dataDir.ensureRunDir(7);
  fs.mkdirSync(dataDir.attemptsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const req = new Request('http://127.0.0.1/files');
const runFile = (id: string, name: string) => getRunFile(req, { params: Promise.resolve({ id, name }) });
const attemptFile = (name: string) => getAttemptFile(req, { params: Promise.resolve({ name }) });

test('serves transcript inside data dir', async () => {
  fs.writeFileSync(dataDir.transcriptPath(7), '# Transcript\nhello');
  const res = await runFile('7', 'transcript.md');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await res.text()).toBe('# Transcript\nhello');
});

test('serves result json with json content type', async () => {
  fs.writeFileSync(dataDir.resultPath(7), '{"schemaVersion":1}');
  const res = await runFile('7', 'result.json');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(await res.json()).toEqual({ schemaVersion: 1 });
});

test('rejects traversal name with 404', async () => {
  fs.writeFileSync(path.join(root, 'secret.md'), 'secret');
  expect((await runFile('7', '../../../secret.md')).status).toBe(404);
  expect((await runFile('..', 'transcript.md')).status).toBe(404);
  expect((await attemptFile('../../secret.json')).status).toBe(404);
  expect((await attemptFile('..%2F..%2Fsecret.json')).status).toBe(404);
});

test('rejects unknown file name with 404', async () => {
  fs.writeFileSync(path.join(dataDir.runDir(7), 'notes.txt'), 'x');
  expect((await runFile('7', 'notes.txt')).status).toBe(404);
  expect((await runFile('7', 'automator.db')).status).toBe(404);
  fs.writeFileSync(path.join(dataDir.attemptsDir, 'a.txt'), 'x');
  expect((await attemptFile('a.txt')).status).toBe(404);
});

test('serves attempt json file', async () => {
  fs.writeFileSync(path.join(dataDir.attemptsDir, '2026-10-21T10-00-00Z-abc.json'), '{"schemaVersion":1}');
  const res = await attemptFile('2026-10-21T10-00-00Z-abc.json');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
});

test('rejects symlink escaping data dir', async () => {
  fs.writeFileSync(path.join(root, 'outside.md'), 'outside');
  fs.writeFileSync(path.join(root, 'outside.json'), '{}');
  fs.symlinkSync(path.join(root, 'outside.md'), dataDir.transcriptPath(7));
  fs.symlinkSync(path.join(root, 'outside.json'), path.join(dataDir.attemptsDir, 'x.json'));
  expect((await runFile('7', 'transcript.md')).status).toBe(404);
  expect((await attemptFile('x.json')).status).toBe(404);
});

test('serves files when the data dir itself is reached through a symlink', async () => {
  const link = path.join(root, 'data-link');
  fs.symlinkSync(dataDir.root, link);
  core.dataDir = new DataDir(link);
  fs.writeFileSync(dataDir.cliLogPath(7), 'log');
  expect((await runFile('7', 'cli.log')).status).toBe(200);
});
