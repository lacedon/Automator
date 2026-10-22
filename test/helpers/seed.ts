// Seeds Watches and Runs for the dashboard: used by the Playwright smoke tests and for eyeballing the UI.
// CLI: `npx tsx test/helpers/seed.ts <dataDir>` writes <dataDir>/automator.config.json and seeds it;
// start the web app with AUTOMATOR_CONFIG pointing at that file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, type Core } from '../../src/core/index';

// Writes a config whose data lives in <root> and whose only Repository, `pages`, is a real empty folder.
export function writeSeedConfig(root: string): string {
  fs.mkdirSync(path.join(root, 'repos', 'pages'), { recursive: true });
  const configPath = path.join(root, 'automator.config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        dataDir: '.',
        repositories: { pages: { folder: './repos/pages', gitlab: 'corp' } },
        gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
        jira: { enabled: false },
        runs: { defaultModel: 'claude-sonnet-4.5', models: ['claude-sonnet-4.5'] },
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

// Expects a fresh data dir with a `pages` Repository (see writeSeedConfig).
export function seed(core: Core): void {
  const { db, dataDir } = core;
  const now = Date.now();
  const MIN = 60_000;

  function insertWatch(n: number, title: string, state: 'active' | 'needs_you'): number {
    const info = db
      .prepare(
        `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, next_check_at, created_at, updated_at)
         VALUES ('mr', ?, ?, 'pages', ?, ?, ?, ?, ?)`,
      )
      .run(
        `https://gitlab.example.com/web/pages/-/merge_requests/${n}`,
        `gitlab:gitlab.example.com/web/pages!${n}`,
        title,
        state,
        now + 15 * MIN,
        now - 3 * 24 * 60 * MIN,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  function insertFinishedRun(
    watchId: number,
    minutesAgo: number,
    outcome: 'acted' | 'nothing' | 'needs-you',
    summary: string,
  ): number {
    const ended = now - minutesAgo * MIN;
    const info = db
      .prepare(
        `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, model, queued_at, started_at, ended_at,
           pid, exit_code, result_status, outcome, summary)
         VALUES (?, 'pages', 'finished', 'schedule', 1, 'new comment by @anna', 'claude-sonnet-4.5', ?, ?, ?, 4242, 0, 'success', ?, ?)`,
      )
      .run(watchId, ended - 6 * MIN, ended - 5 * MIN, ended, outcome, summary);
    const id = Number(info.lastInsertRowid);
    dataDir.ensureRunDir(id);
    fs.writeFileSync(dataDir.promptPath(id), `# Prompt for Run #${id}\n`);
    fs.writeFileSync(dataDir.transcriptPath(id), `# Transcript of Run #${id}\n\n${summary}\n`);
    fs.writeFileSync(dataDir.resultPath(id), `${JSON.stringify({ schemaVersion: 1, outcome, summary }, null, 2)}\n`);
    db.prepare('UPDATE runs SET prompt_path = ?, transcript_path = ?, result_path = ? WHERE id = ?').run(
      dataDir.promptPath(id),
      dataDir.transcriptPath(id),
      dataDir.resultPath(id),
      id,
    );
    return id;
  }

  const needsYou = insertWatch(42, '!42 Add retry to export job', 'needs_you');
  const active = insertWatch(51, '!51 Bump eslint config', 'active');

  insertFinishedRun(active, 120, 'nothing', 'No new activity');
  insertFinishedRun(active, 12, 'acted', 'Replied to 2 comments, pushed fix');
  const failed = insertFinishedRun(needsYou, 3, 'needs-you', 'Validation failed: npm test');
  db.prepare(
    `UPDATE watches SET needs_you_reason = 'Validation failed: npm test', needs_you_since = ?, needs_you_run_id = ? WHERE id = ?`,
  ).run(now - 3 * MIN, failed, needsYou);

  db.prepare(
    `INSERT INTO needs_you_events (watch_id, run_id, reason, created_at, teams_status) VALUES (?, ?, 'Validation failed: npm test', ?, 'sent')`,
  ).run(needsYou, failed, now - 3 * MIN);
  db.prepare(
    `UPDATE watches SET mr_source_branch = 'feature/export-retry', instructions = 'Keep changes minimal.',
       cursor_json = '{"lastNoteId":9921,"handledPipelineId":55102,"handledConflictSha":null}' WHERE id = ?`,
  ).run(needsYou);

  // One Watch per remaining state/kind so every Next check text and row menu variant shows up.
  const insertOther = db.prepare(
    `INSERT INTO watches (kind, target_url, normalized_target, repository, title, state, instructions, closed_reason, closed_at,
       created_at, updated_at)
     VALUES (?, ?, ?, 'pages', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertOther.run(
    'jira',
    'https://jira.example.com/browse/PROJ-1880',
    'jira:jira.example.com/PROJ-1880',
    'PROJ-1880 Report export perf',
    'paused',
    null,
    null,
    null,
    now,
    now,
  );
  insertOther.run(
    'jira',
    'https://jira.example.com/browse/PROJ-1931',
    'jira:jira.example.com/PROJ-1931',
    'PROJ-1931 Clarify SSO timeout',
    'active',
    null,
    null,
    null,
    now,
    now,
  );
  insertOther.run(
    'free',
    'https://wiki.example.com/release',
    'https://wiki.example.com/release',
    'docs-sync — wiki.example.com/release',
    'active',
    'Sync release notes into docs/.',
    null,
    null,
    now,
    now,
  );
  const closed = Number(
    insertOther.run(
      'mr',
      'https://gitlab.example.com/web/pages/-/merge_requests/38',
      'gitlab:gitlab.example.com/web/pages!38',
      '!38 Remove legacy auth',
      'closed',
      null,
      'merged',
      now - 6 * 24 * 60 * MIN,
      now - 10 * 24 * 60 * MIN,
      now,
    ).lastInsertRowid,
  );
  insertFinishedRun(closed, 6 * 24 * 60, 'acted', 'Merged after final review');

  db.prepare(
    `INSERT INTO runs (repository, status, trigger, priority, reason, adhoc_prompt, model, queued_at, started_at, pid)
     VALUES ('pages', 'running', 'adhoc', 0, 'ad-hoc', 'Summarize open TODOs in src/', 'claude-sonnet-4.5', ?, ?, 4243)`,
  ).run(now - 5 * MIN, now - 4 * MIN);

  // Queue, Runs and Ad-hoc pages: waiting rows of every priority, an error before start, a timeout and a finished ad-hoc Run.
  const insertRun = db.prepare(
    `INSERT INTO runs (watch_id, repository, status, trigger, priority, reason, adhoc_prompt, model, queued_at, started_at, ended_at,
       pid, result_status, outcome, summary, error_json, interrupted)
     VALUES (@watchId, 'pages', @status, @trigger, @priority, @reason, @prompt, 'claude-sonnet-4.5', @queuedAt, @startedAt, @endedAt,
       @pid, @resultStatus, @outcome, @summary, @error, @interrupted)`,
  );
  const run = (fields: Partial<Record<string, unknown>>) =>
    insertRun.run({
      watchId: null,
      status: 'finished',
      trigger: 'schedule',
      priority: 1,
      reason: 'scheduled check',
      prompt: null,
      queuedAt: now - 30 * MIN,
      startedAt: null,
      endedAt: null,
      pid: null,
      resultStatus: null,
      outcome: null,
      summary: null,
      error: null,
      interrupted: null,
      ...fields,
    });
  const jiraActive = (
    db.prepare("SELECT id FROM watches WHERE normalized_target = 'jira:jira.example.com/PROJ-1931'").get() as {
      id: number;
    }
  ).id;
  run({
    watchId: jiraActive,
    status: 'queued',
    trigger: 'manual',
    priority: 0,
    reason: 'Resume & run now',
    queuedAt: now - 2 * MIN,
  });
  run({ watchId: active, status: 'queued', reason: 'new comment by @anna', queuedAt: now - 3 * MIN });
  run({
    status: 'queued',
    trigger: 'adhoc',
    priority: 0,
    reason: 'ad-hoc',
    prompt: 'Regenerate API types',
    queuedAt: now - MIN,
  });
  run({
    watchId: needsYou,
    startedAt: now - 40 * MIN,
    endedAt: now - 40 * MIN,
    resultStatus: 'error',
    error: JSON.stringify({ code: 'GITLAB_AUTH', message: "GitLab 401 — token can't access MR" }),
  });
  run({
    watchId: active,
    trigger: 'manual',
    priority: 0,
    reason: 'manual',
    startedAt: now - 90 * MIN,
    endedAt: now - 60 * MIN,
    pid: 4100,
    resultStatus: 'error',
    error: JSON.stringify({ code: 'TIMEOUT', message: 'Run timed out after 30m' }),
    interrupted: 'timeout',
  });
  run({
    trigger: 'adhoc',
    priority: 0,
    reason: 'ad-hoc',
    prompt: 'Update CHANGELOG for 4.2',
    startedAt: now - 50 * MIN,
    endedAt: now - 48 * MIN,
    pid: 4101,
    resultStatus: 'success',
    outcome: 'acted',
    summary: 'Committed CHANGELOG entry',
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error('Usage: npx tsx test/helpers/seed.ts <dataDir>');
    process.exit(2);
  }
  const configPath = writeSeedConfig(path.resolve(target));
  const core = bootstrap({ configPath });
  seed(core);
  core.close();
  console.log(`Seeded ${core.dataDir.root}\nAUTOMATOR_CONFIG=${configPath}`);
}
