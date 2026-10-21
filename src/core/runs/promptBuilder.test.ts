import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import type { Config } from '../config/schema';
import type { Run, Watch } from '../domain/types';
import type { EventSummary, Snapshot } from '../prechecks/types';
import { buildAdhocPrompt, buildWatchPrompt, FIXED_RULES, MAX_EVENTS_CHARS } from './promptBuilder';

const RESULT_PATH = '/data/runs/7/copilot-result.json';
const MR_URL = 'https://gitlab.example.com/group/pages/-/merge_requests/12';

afterEach(() => vi.unstubAllEnvs());

function config(validate: string[] = ['npm test']): Config {
  return testConfig({
    prompts: { dir: path.resolve('prompts') },
    repositories: { pages: { validate } },
  });
}

function watch(partial: Partial<Watch> = {}): Watch {
  return {
    id: 1,
    kind: 'mr',
    targetUrl: MR_URL,
    normalizedTarget: 'mr:gitlab.example.com/group/pages!12',
    repository: 'pages',
    title: 'Fix login',
    state: 'active',
    instructions: null,
    intervalMs: null,
    model: null,
    initialReview: null,
    mrSourceBranch: 'feature/login',
    cursor: null,
    nextCheckAt: null,
    checkFailures: 0,
    needsYouReason: null,
    needsYouSince: null,
    needsYouRunId: null,
    resolutionNote: null,
    closedReason: null,
    closedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function run(partial: Partial<Run> = {}): Run {
  return {
    id: 7,
    watchId: 1,
    repository: 'pages',
    status: 'running',
    trigger: 'schedule',
    priority: 1,
    reason: 'New comment by anna',
    adhocPrompt: null,
    extraInstructions: null,
    reviewUnresolved: false,
    model: 'claude-sonnet-4.5',
    queuedAt: 0,
    startedAt: 0,
    endedAt: null,
    pid: null,
    cancelRequestedAt: null,
    exitCode: null,
    resultStatus: null,
    outcome: null,
    summary: null,
    error: null,
    interrupted: null,
    cursorCandidate: null,
    branch: null,
    promptPath: null,
    transcriptPath: null,
    resultPath: null,
    ...partial,
  };
}

function snapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    events: [{ at: Date.UTC(2026, 9, 21, 9), author: 'anna', text: 'Please rename foo', url: `${MR_URL}#note_1` }],
    cursorCandidate: { lastNoteId: 1, handledPipelineId: null, handledConflictSha: null },
    title: 'Fix login',
    sourceBranch: 'feature/login',
    ...partial,
  };
}

type WatchInput = Parameters<typeof buildWatchPrompt>[0];

function watchPrompt(partial: Partial<WatchInput> = {}): string {
  return buildWatchPrompt({
    watch: watch(),
    run: run(),
    snapshot: snapshot(),
    recent: [],
    config: config(),
    resultPath: RESULT_PATH,
    hasJiraToken: false,
    ...partial,
  });
}

function eventsSection(prompt: string): string {
  const start = prompt.indexOf('### Events\n') + '### Events\n'.length;
  const end = prompt.indexOf('\n#', start);
  return prompt.slice(start, end === -1 ? undefined : end);
}

describe('buildWatchPrompt', () => {
  test('sections appear in spec order', () => {
    const prompt = watchPrompt();
    const headings = ['## Rules', '## Default instructions', '## Watch', '## This Run', '## Recent Runs', '## Validation', '## Result'];
    const positions = headings.map((h) => prompt.indexOf(`${h}\n`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).toContain('Handle new outside comments');
  });

  test('fixed rules list every never-allowed action', () => {
    for (const phrase of [
      'merge',
      'approve',
      'resolve discussions',
      'force-push',
      'delete remote branches',
      'protected branches',
      'Jira statuses',
      'reassign',
      'ticket descriptions',
      'untrusted',
    ]) {
      expect(FIXED_RULES).toContain(phrase);
    }
    expect(watchPrompt()).toContain(FIXED_RULES);
  });

  test('MR prompt names the source branch in the pre-action checklist', () => {
    const prompt = watchPrompt({ snapshot: snapshot({ sourceBranch: 'feature/new-name' }) });
    const rules = prompt.slice(prompt.indexOf('## Rules'), prompt.indexOf('## Default instructions'));
    expect(rules).toContain('Re-read the current state of the MR');
    expect(rules).toContain('Confirm that you are on the MR source branch `feature/new-name`');
    expect(rules).toContain('Run the validation commands');
  });

  test('free-form has no default instructions section', () => {
    const prompt = watchPrompt({
      watch: watch({ kind: 'free', targetUrl: 'https://example.com/page', mrSourceBranch: null, instructions: 'Check the page' }),
      snapshot: snapshot({ events: [], cursorCandidate: {}, sourceBranch: undefined }),
    });
    expect(prompt).not.toContain('## Default instructions');
    expect(prompt).not.toContain('source branch `');
    expect(prompt).toContain('Check the page');
  });

  test('jira without token tells Copilot to check via MCP', () => {
    const jira = watch({ kind: 'jira', targetUrl: 'https://jira.example.com/browse/ABC-1', mrSourceBranch: null });
    const jiraSnapshot = snapshot({ events: [], cursorCandidate: { lastChangelogId: null, lastCommentId: null }, sourceBranch: undefined });
    const without = watchPrompt({ watch: jira, snapshot: jiraSnapshot, hasJiraToken: false });
    expect(without).toContain('check the ticket through MCP');
    expect(without).toContain('Do not change code unless the Watch instructions');
    const withToken = watchPrompt({ watch: jira, snapshot: jiraSnapshot, hasJiraToken: true });
    expect(withToken).not.toContain('through MCP');
  });

  test('includes resolution note and last 3 run summaries only', () => {
    const prompt = watchPrompt({
      watch: watch({ resolutionNote: 'Go with option B' }),
      recent: [
        { id: 1, outcome: 'acted', summary: 'summary-oldest', endedAt: 1000 },
        { id: 4, outcome: 'nothing', summary: 'summary-newest', endedAt: 4000 },
        { id: 2, outcome: 'needs-you', summary: 'summary-second', endedAt: 2000 },
        { id: 3, outcome: 'acted', summary: 'summary-third', endedAt: 3000 },
      ],
    });
    expect(prompt).toContain('Go with option B');
    expect(prompt).not.toContain('summary-oldest');
    const recent = prompt.slice(prompt.indexOf('## Recent Runs'), prompt.indexOf('## Validation'));
    const order = ['summary-newest', 'summary-third', 'summary-second'].map((s) => recent.indexOf(s));
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('empty validate yields escalate-before-pushing line', () => {
    const prompt = watchPrompt({ config: config([]) });
    const validation = prompt.slice(prompt.indexOf('## Validation'), prompt.indexOf('## Result'));
    expect(validation).toContain('None configured: escalate before pushing');
    expect(watchPrompt()).toContain('- `npm test`');
  });

  test('result contract contains absolute result path and outcome values', () => {
    const prompt = watchPrompt();
    expect(prompt).toContain(`write exactly this JSON to \`${RESULT_PATH}\``);
    expect(prompt.match(/write exactly this JSON to `([^`]+)`/)?.[1]).toBe(RESULT_PATH);
    expect(prompt).toContain('{"outcome": "nothing"|"acted"|"needs-you", "summary": "<= 500 chars"}');
  });

  test('never includes secret values', () => {
    vi.stubEnv('GITLAB_TOKEN', 's3cr3t');
    vi.stubEnv('JIRA_TOKEN', 's3cr3t');
    const prompt = watchPrompt({ hasJiraToken: true });
    expect(prompt).not.toContain('s3cr3t');
  });

  test('caps events section at 100000 chars keeping newest', () => {
    const events: EventSummary[] = Array.from({ length: 5000 }, (_, i) => ({
      at: Date.UTC(2026, 0, 1) + i * 1000,
      author: 'anna',
      text: `event-${String(i).padStart(4, '0')} ${'x'.repeat(100 - 'event-0000 '.length)}`,
    }));
    const prompt = watchPrompt({ snapshot: snapshot({ events }) });
    const section = eventsSection(prompt);
    expect(section.length).toBeLessThanOrEqual(MAX_EVENTS_CHARS);
    expect(section).toContain('event-4999');
    expect(section).not.toContain('event-0000');
    expect(section).toMatch(/^\(\d+ older events omitted\)$/m);
    expect(section.indexOf('event-4998')).toBeLessThan(section.indexOf('event-4999'));
  });

  test('renders each event as one list item with time, author, text and url', () => {
    expect(eventsSection(watchPrompt())).toContain(
      `- 2026-10-21T09:00:00.000Z anna: Please rename foo (${MR_URL}#note_1)`,
    );
  });

  test('missing default prompt file throws naming the path', () => {
    const cfg = testConfig({ prompts: { dir: path.resolve('test-results', 'no-prompts') } });
    expect(() => watchPrompt({ config: cfg })).toThrow(path.join(cfg.prompts.dir, 'mr.md'));
  });
});

describe('buildAdhocPrompt', () => {
  test('adhoc prompt includes user prompt and result contract, no Watch section', () => {
    const prompt = buildAdhocPrompt({
      run: run({ watchId: null, trigger: 'adhoc', adhocPrompt: 'Bump the lodash version' }),
      config: config(),
      resultPath: RESULT_PATH,
    });
    expect(prompt).toContain(FIXED_RULES);
    expect(prompt).toContain('Bump the lodash version');
    expect(prompt).toContain(`write exactly this JSON to \`${RESULT_PATH}\``);
    expect(prompt).toContain('- `npm test`');
    expect(prompt).not.toContain('## Watch');
    expect(prompt).not.toContain('## Default instructions');
    expect(prompt).not.toContain('## Recent Runs');
  });
});
