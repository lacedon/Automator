import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { testConfig, type DeepPartial } from '../../../test/helpers/config';
import { insertWatch, tempDb } from '../../../test/helpers/db';
import { resolveSecrets } from '../config/load';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toNeedsYouEvent } from '../db/rows';
import type { NeedsYouEvent } from '../domain/types';
import { DataDir } from '../files/dataDir';
import { createCopilotLauncher, type CopilotLauncher } from '../runs/copilotLauncher';
import { enterNeedsYou } from '../watches/needsYou';
import { createTeamsNotifier } from './teamsNotifier';

const FAKE = path.resolve('test/fixtures/fake-copilot.mjs');
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const TEAMS = {
  chatId: '19:abc@thread.v2',
  tool: 'teams-global(send_chat_message)',
  dashboardUrl: 'http://127.0.0.1:4317',
};

type SetupOpts = {
  mode?: string;
  config?: DeepPartial<Config>;
  teams?: Config['teams'] | null;
  timeoutMs?: number;
  logPrefix?: string;
};

function setup(opts: SetupOpts = {}) {
  const t = tempDb();
  cleanups.push(t.cleanup);
  const config = testConfig({ copilotBin: FAKE, ...opts.config });
  config.teams = opts.teams === null ? undefined : (opts.teams ?? { ...TEAMS });
  const secrets = resolveSecrets(config, { GITLAB_TOKEN: 'glpat-secret' });
  const dataDir = new DataDir(config.dataDir);
  fs.mkdirSync(dataDir.root, { recursive: true });
  const recordPath = path.join(config.configDir, 'record.json');
  const pidFile = path.join(config.configDir, 'child.pid');
  const real = createCopilotLauncher(config, secrets);
  const starts: Parameters<CopilotLauncher['start']>[0][] = [];
  const launcher: CopilotLauncher = {
    start(o) {
      starts.push(o);
      if (opts.logPrefix !== undefined) fs.writeFileSync(o.logPath, opts.logPrefix);
      return real.start({
        ...o,
        env: {
          ...o.env,
          FAKE_COPILOT_MODE: opts.mode ?? 'nothing',
          FAKE_COPILOT_RECORD: recordPath,
          FAKE_COPILOT_CHILD_PID_FILE: pidFile,
        },
      });
    },
  };
  const notifier = createTeamsNotifier({ db: t.db, config, launcher, dataDir, secrets, timeoutMs: opts.timeoutMs });
  return { db: t.db, config, dataDir, notifier, starts, recordPath, pidFile };
}

function needsYou(db: Database, teamsEnabled = true): { event: NeedsYouEvent; watchId: number } {
  const watchId = insertWatch(db, { title: 'Fix login' });
  const event = enterNeedsYou(db, { watchId, runId: null, reason: 'pipeline failed', now: 1, teamsEnabled });
  if (event === null) throw new Error('no event');
  return { event, watchId };
}

const load = (db: Database, id: number) =>
  toNeedsYouEvent(db.prepare('SELECT * FROM needs_you_events WHERE id = ?').get(id));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('TeamsNotifier', () => {
  test('sends with available-tools restricted and marks sent', async () => {
    const s = setup({ config: { runs: { defaultModel: 'claude-sonnet-4.5' } } });
    const { event, watchId } = needsYou(s.db);

    await s.notifier.notifyNeedsYou(event);

    expect(load(s.db, event.id)).toMatchObject({ teamsStatus: 'sent', teamsError: null });
    const record = JSON.parse(fs.readFileSync(s.recordPath, 'utf8')) as { argv: string[]; cwd: string };
    const arg = (flag: string) => record.argv[record.argv.indexOf(flag) + 1];
    expect(arg('--available-tools')).toBe('teams-global(send_chat_message)');
    expect(arg('--model')).toBe('claude-sonnet-4.5');
    expect(arg('-p')).toBe(
      'Send exactly this message to the Microsoft Teams chat with id 19:abc@thread.v2 using the available Teams tool, then stop. ' +
        `Message: Automator: "Fix login" needs you: pipeline failed. http://127.0.0.1:4317/watches/${watchId}`,
    );
    expect(fs.realpathSync(record.cwd)).toBe(fs.realpathSync(s.dataDir.root));
    expect(s.starts[0]).toMatchObject({
      cwd: s.dataDir.root,
      transcriptPath: path.join(s.dataDir.root, 'notify', `${event.id}.md`),
      logPath: path.join(s.dataDir.root, 'notify', `${event.id}.log`),
    });
    expect(fs.existsSync(path.join(s.dataDir.root, 'notify', `${event.id}.md`))).toBe(true);
  });

  test('child env comes from process env with secrets removed', async () => {
    process.env.GITLAB_TOKEN = 'glpat-secret';
    cleanups.push(() => delete process.env.GITLAB_TOKEN);
    const s = setup();
    const { event } = needsYou(s.db);

    await s.notifier.notifyNeedsYou(event);

    expect(s.starts[0]?.env.GITLAB_TOKEN).toBeUndefined();
    expect(s.starts[0]?.env.PATH).toBe(process.env.PATH);
  });

  test('uses teams.model when configured', async () => {
    const s = setup({ teams: { ...TEAMS, model: 'gpt-5-mini' } });
    const { event } = needsYou(s.db);

    await s.notifier.notifyNeedsYou(event);

    const record = JSON.parse(fs.readFileSync(s.recordPath, 'utf8')) as { argv: string[] };
    expect(record.argv[record.argv.indexOf('--model') + 1]).toBe('gpt-5-mini');
  });

  test('exit 1 marks failed with error text', async () => {
    const s = setup({ mode: 'exit-1', logPrefix: `${'a'.repeat(600)}${'b'.repeat(500)}\n\n` });
    const { event } = needsYou(s.db);

    await s.notifier.notifyNeedsYou(event);

    const after = load(s.db, event.id);
    expect(after.teamsStatus).toBe('failed');
    expect(after.teamsError).toBe(`Exit code 1: ${'b'.repeat(498)}`);
  });

  test('timeout marks failed', async () => {
    const s = setup({ mode: 'hang', timeoutMs: 300 });
    const { event } = needsYou(s.db);

    await s.notifier.notifyNeedsYou(event);

    expect(load(s.db, event.id)).toMatchObject({ teamsStatus: 'failed', teamsError: 'Timed out after 0.3 s' });
    const grandchild = Number(fs.readFileSync(s.pidFile, 'utf8'));
    await expect.poll(() => isAlive(grandchild)).toBe(false);
  });

  test('spawn error marks failed with the error message', async () => {
    const s = setup({ config: { copilotBin: '/nonexistent/copilot' } });
    const { event } = needsYou(s.db);

    await expect(s.notifier.notifyNeedsYou(event)).resolves.toBeUndefined();

    const after = load(s.db, event.id);
    expect(after.teamsStatus).toBe('failed');
    expect(after.teamsError).toContain('ENOENT');
  });

  test('no teams config leaves event disabled and does not spawn', async () => {
    const s = setup({ teams: null });
    const { event } = needsYou(s.db, false);

    await s.notifier.notifyNeedsYou(event);

    expect(s.starts).toHaveLength(0);
    expect(load(s.db, event.id)).toMatchObject({ teamsStatus: 'disabled', teamsError: null });
  });

  test('event that is not pending is a no-op', async () => {
    const s = setup();
    const { event } = needsYou(s.db);
    s.db.prepare("UPDATE needs_you_events SET teams_status = 'sent' WHERE id = ?").run(event.id);

    await s.notifier.notifyNeedsYou({ ...event, teamsStatus: 'sent' });

    expect(s.starts).toHaveLength(0);
    expect(load(s.db, event.id).teamsStatus).toBe('sent');
  });
});
