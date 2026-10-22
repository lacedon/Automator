import fs from 'node:fs';
import path from 'node:path';
import { DataDir } from '@core/index';

export function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// Resolves symlinks on both sides so a link inside the data dir can't point outside it.
export function serveDataFile(dataDir: DataDir, file: string): Response {
  let real: string;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(dataDir.root);
    real = fs.realpathSync(file);
  } catch {
    return notFound();
  }
  if (!new DataDir(realRoot).isInside(real) || !fs.statSync(real).isFile()) return notFound();
  const contentType = path.extname(file) === '.json' ? 'application/json' : 'text/plain; charset=utf-8';
  return new Response(fs.readFileSync(real, 'utf8'), { headers: { 'Content-Type': contentType } });
}
