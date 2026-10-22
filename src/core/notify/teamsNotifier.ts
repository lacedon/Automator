import fs from 'node:fs';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { NeedsYouEvent } from '../domain/types';
import type { DataDir } from '../files/dataDir';
import { childEnv, type CopilotExit, type CopilotLauncher } from '../runs/copilotLauncher';

export interface Notifier {
  notifyNeedsYou(event: NeedsYouEvent): Promise<void>;
}

export interface TeamsNotifierDeps {
  db: Database;
  config: Config;
  launcher: CopilotLauncher;
  dataDir: DataDir;
  secrets: Secrets;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ERROR_TAIL_CHARS = 500;

function logTail(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf8').slice(-ERROR_TAIL_CHARS).trim();
  } catch {
    return '';
  }
}

export function createTeamsNotifier(deps: TeamsNotifierDeps): Notifier {
  const { db, config, launcher, dataDir, secrets } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const finish = (eventId: number, status: 'sent' | 'failed', error: string | null): void => {
    db.prepare(
      "UPDATE needs_you_events SET teams_status = ?, teams_error = ? WHERE id = ? AND teams_status = 'pending'",
    ).run(status, error, eventId);
  };

  const send = async (event: NeedsYouEvent, teams: NonNullable<Config['teams']>): Promise<void> => {
    const watch = db.prepare('SELECT title FROM watches WHERE id = ?').get(event.watchId) as
      { title: string } | undefined;
    const title = watch?.title ?? `Watch ${event.watchId}`;
    const message = `Automator: "${title}" needs you: ${event.reason}. ${teams.dashboardUrl}/watches/${event.watchId}`;
    const prompt =
      `Send exactly this message to the Microsoft Teams chat with id ${teams.chatId} using the available Teams tool, then stop. ` +
      `Message: ${message}`;

    fs.mkdirSync(dataDir.notifyDir, { recursive: true });
    const logPath = dataDir.notifyLogPath(event.id);

    const proc = launcher.start({
      cwd: dataDir.root,
      prompt,
      model: teams.model ?? config.runs.defaultModel,
      transcriptPath: dataDir.notifyTranscriptPath(event.id),
      logPath,
      env: childEnv(process.env, secrets),
      extraArgs: ['--available-tools', teams.tool],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    let exit: CopilotExit;
    try {
      exit = await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) finish(event.id, 'failed', `Timed out after ${timeoutMs / 1000} s`);
    else if (exit.spawnError !== undefined) finish(event.id, 'failed', exit.spawnError);
    else if (exit.code === 0) finish(event.id, 'sent', null);
    else finish(event.id, 'failed', `Exit code ${exit.code ?? exit.signal ?? 'unknown'}: ${logTail(logPath)}`);
  };

  return {
    async notifyNeedsYou(event) {
      const teams = config.teams;
      if (teams === undefined || event.teamsStatus !== 'pending') return;
      try {
        await send(event, teams);
      } catch (error) {
        try {
          finish(event.id, 'failed', error instanceof Error ? error.message : String(error));
        } catch {
          // Best effort: a notification failure must never break the worker loop.
        }
      }
    },
  };
}
