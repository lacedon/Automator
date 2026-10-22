import fs from 'node:fs';
import path from 'node:path';

export class DataDir {
  readonly root: string;
  readonly db: string;
  readonly attemptsDir: string;
  readonly notifyDir: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.db = path.join(this.root, 'automator.db');
    this.attemptsDir = path.join(this.root, 'attempts');
    this.notifyDir = path.join(this.root, 'notify');
  }

  runDir(id: number): string {
    return path.join(this.root, 'runs', String(id));
  }

  promptPath(id: number): string {
    return path.join(this.runDir(id), 'prompt.md');
  }

  transcriptPath(id: number): string {
    return path.join(this.runDir(id), 'transcript.md');
  }

  copilotResultPath(id: number): string {
    return path.join(this.runDir(id), 'copilot-result.json');
  }

  resultPath(id: number): string {
    return path.join(this.runDir(id), 'result.json');
  }

  cliLogPath(id: number): string {
    return path.join(this.runDir(id), 'cli.log');
  }

  ensureRunDir(id: number): string {
    const dir = this.runDir(id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  removeRunDir(id: number): void {
    fs.rmSync(this.runDir(id), { recursive: true, force: true });
  }

  notifyTranscriptPath(eventId: number): string {
    return path.join(this.notifyDir, `${eventId}.md`);
  }

  notifyLogPath(eventId: number): string {
    return path.join(this.notifyDir, `${eventId}.log`);
  }

  removeNotifyFiles(eventId: number): void {
    fs.rmSync(this.notifyTranscriptPath(eventId), { force: true });
    fs.rmSync(this.notifyLogPath(eventId), { force: true });
  }

  isInside(p: string): boolean {
    const rel = path.relative(this.root, path.resolve(p));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  }
}
