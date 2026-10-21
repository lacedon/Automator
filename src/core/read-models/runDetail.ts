import fs from 'node:fs/promises';
import type { Run } from '../domain/types';
import type { ReadDeps } from './deps';
import { RUNS_WITH_TITLE, tookMs, toRunWithTitle } from './runs';

export const FILE_CAP_BYTES = 5 * 1024 * 1024;

export type FileView = { path: string; content: string | null; truncated: boolean };

export type RunDetailView = {
  run: Run;
  watchTitle: string | null;
  tookMs: number | null;
  transcript: FileView;
  result: FileView;
  prompt: FileView;
};

async function readCapped(file: string): Promise<FileView> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, content: null, truncated: false };
    throw e;
  }
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, FILE_CAP_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { path: file, content: buffer.toString('utf8', 0, bytesRead), truncated: size > FILE_CAP_BYTES };
  } finally {
    await handle.close();
  }
}

export async function runDetail(deps: ReadDeps, id: number): Promise<RunDetailView | null> {
  const { db, dataDir } = deps;
  const row = db.prepare(`${RUNS_WITH_TITLE} WHERE r.id = ?`).get(id);
  if (row === undefined) return null;
  const { watchTitle, ...run } = toRunWithTitle(row);
  const [transcript, result, prompt] = await Promise.all([
    readCapped(run.transcriptPath ?? dataDir.transcriptPath(id)),
    readCapped(run.resultPath ?? dataDir.resultPath(id)),
    readCapped(run.promptPath ?? dataDir.promptPath(id)),
  ]);
  return { run, watchTitle, tookMs: tookMs(run), transcript, result, prompt };
}
