import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parseDuration } from '../domain/duration';

export function resolvePath(p: string, baseDir: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(baseDir, p);
}

const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();

const duration = z.string().transform((s, ctx) => {
  let ms: number;
  try {
    ms = parseDuration(s);
  } catch {
    ctx.addIssue({ code: 'custom', message: `Invalid duration "${s}" (expected e.g. 90s, 15m, 2h, 1d)` });
    return z.NEVER;
  }
  if (ms <= 0) {
    ctx.addIssue({ code: 'custom', message: `Duration must be greater than zero, got "${s}"` });
    return z.NEVER;
  }
  return ms;
});

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');

export function createConfigSchema(configDir: string) {
  const pathField = nonEmpty.transform((p) => resolvePath(p, configDir));

  return z
    .object({
      dataDir: pathField.prefault('~/.automator'),
      copilotBin: nonEmpty.default('copilot'),
      repositories: z.record(
        z.string(),
        z.object({
          folder: pathField,
          gitlab: nonEmpty,
          jira: nonEmpty.optional(),
          validate: z.array(z.string()).default([]),
        }),
      ),
      gitlab: z.record(z.string(), z.object({ host: nonEmpty, tokenEnv: nonEmpty })),
      jira: z
        .object({
          enabled: z.boolean().default(false),
          connections: z
            .record(
              z.string(),
              z.object({
                baseUrl: nonEmpty,
                emailEnv: nonEmpty.optional(),
                tokenEnv: nonEmpty.optional(),
                doneStatusIds: z.array(z.string()).optional(),
              }),
            )
            .default({}),
        })
        .prefault({}),
      schedule: z
        .object({
          intervals: z
            .object({ mr: duration.prefault('15m'), default: duration.prefault('2h') })
            .prefault({}),
          workingHours: z
            .object({
              days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
              start: clockTime.default('08:00'),
              end: clockTime.default('19:00'),
            })
            .superRefine(({ days, start, end }, ctx) => {
              if (days.length === 0) {
                ctx.addIssue({ code: 'custom', path: ['days'], message: 'At least one working day is required' });
              } else if (new Set(days).size !== days.length) {
                ctx.addIssue({ code: 'custom', path: ['days'], message: 'Working days must not repeat' });
              }
              if (start >= end) ctx.addIssue({ code: 'custom', path: ['end'], message: `Must be later than start (${start})` });
            })
            .prefault({}),
        })
        .prefault({}),
      runs: z
        .object({
          timeoutMinutes: positiveInt.default(30),
          defaultModel: nonEmpty.default('claude-sonnet-4.5'),
          models: z.array(z.string()).default([]),
          initialReview: z.enum(['baseline-only', 'unresolved']).default('baseline-only'),
          denyTools: z.array(z.string()).default([]),
        })
        .prefault({})
        .transform(({ timeoutMinutes, ...rest }) => ({ timeoutMs: timeoutMinutes * 60_000, ...rest })),
      prompts: z.object({ dir: pathField.prefault('./prompts') }).prefault({}),
      cleanup: z
        .object({
          enabled: z.boolean().default(true),
          everyDays: positiveInt.default(7),
          retainClosedDays: positiveInt.default(30),
        })
        .prefault({}),
      teams: z
        .object({
          chatId: nonEmpty,
          tool: nonEmpty.default('teams-global(send_chat_message)'),
          model: nonEmpty.optional(),
          dashboardUrl: nonEmpty.default('http://127.0.0.1:4317'),
        })
        .optional(),
    });
}

export type ReferenceIssue = { path: string[]; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Runs on the raw input so reference errors are reported even when other fields fail validation.
// Malformed parts are skipped here; the schema reports them.
export function findReferenceIssues(raw: unknown): ReferenceIssue[] {
  if (!isRecord(raw) || !isRecord(raw.repositories)) return [];
  const gitlab = isRecord(raw.gitlab) ? raw.gitlab : undefined;
  const jira: Record<string, unknown> | undefined = raw.jira === undefined ? {} : isRecord(raw.jira) ? raw.jira : undefined;
  const connections = jira?.connections ?? {};
  const jiraConnections = jira && isRecord(connections) ? connections : undefined;

  const issues: ReferenceIssue[] = [];
  for (const [name, repo] of Object.entries(raw.repositories)) {
    if (!isRecord(repo)) continue;
    if (gitlab && typeof repo.gitlab === 'string' && repo.gitlab !== '' && !Object.hasOwn(gitlab, repo.gitlab)) {
      issues.push({ path: ['repositories', name, 'gitlab'], message: `Unknown gitlab connection "${repo.gitlab}"` });
    }
    if (jiraConnections && typeof repo.jira === 'string' && repo.jira !== '' && !Object.hasOwn(jiraConnections, repo.jira)) {
      issues.push({ path: ['repositories', name, 'jira'], message: `Unknown jira connection "${repo.jira}"` });
    }
  }
  return issues;
}

export type Config = z.output<ReturnType<typeof createConfigSchema>> & { configDir: string };
