import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { writeJsonAtomic } from '../files/atomic';
import { ConfigError } from './load';
import { createConfigSchema, findReferenceIssues, type ConfigInput } from './schema';

export type EditableConfig = Omit<ConfigInput, 'gitlab' | 'jira' | 'prompts'> & {
  gitlab: Record<string, { host: string }>;
  jira: { enabled: boolean; connections: Record<string, { baseUrl: string; doneStatusIds?: string[] }> };
};

const editableFields = ['dataDir', 'copilotBin', 'repositories', 'schedule', 'runs', 'cleanup', 'teams'] as const;
const repositoryFields = ['folder', 'gitlab', 'github', 'jira', 'validate', 'promptAddition'] as const;
const scheduleFields = ['intervals', 'workingHours'] as const;
const intervalFields = ['mr', 'default'] as const;
const workingHoursFields = ['days', 'start', 'end'] as const;
const runFields = ['timeoutMinutes', 'defaultModel', 'models', 'initialReview', 'denyTools'] as const;
const cleanupFields = ['enabled', 'everyDays', 'retainClosedDays'] as const;
const teamsFields = ['chatId', 'tool', 'model', 'dashboardUrl'] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(value: RecordValue, fields: readonly string[]): RecordValue {
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
  );
}

function projectConfig(
  raw: RecordValue,
  parsedJira: z.output<ReturnType<typeof createConfigSchema>>['jira'],
): EditableConfig {
  const result = pick(raw, editableFields);

  if (isRecord(raw.repositories)) {
    result.repositories = Object.fromEntries(
      Object.entries(raw.repositories).map(([name, repository]) => [
        name,
        pick(repository as RecordValue, repositoryFields),
      ]),
    );
  }
  if (isRecord(raw.schedule)) {
    const schedule = pick(raw.schedule, scheduleFields);
    if (isRecord(raw.schedule.intervals)) schedule.intervals = pick(raw.schedule.intervals, intervalFields);
    if (isRecord(raw.schedule.workingHours))
      schedule.workingHours = pick(raw.schedule.workingHours, workingHoursFields);
    result.schedule = schedule;
  }
  if (isRecord(raw.runs)) result.runs = pick(raw.runs, runFields);
  if (isRecord(raw.cleanup)) result.cleanup = pick(raw.cleanup, cleanupFields);
  if (isRecord(raw.teams)) result.teams = pick(raw.teams, teamsFields);

  const gitlab = isRecord(raw.gitlab) ? raw.gitlab : {};
  const jira = isRecord(raw.jira) ? raw.jira : {};
  const jiraConnections = isRecord(jira.connections) ? jira.connections : {};
  return {
    ...result,
    gitlab: Object.fromEntries(
      Object.entries(gitlab).map(([name, connection]) => [name, pick(connection as RecordValue, ['host'])]),
    ) as EditableConfig['gitlab'],
    jira: {
      enabled: typeof jira.enabled === 'boolean' ? jira.enabled : parsedJira.enabled,
      connections: Object.fromEntries(
        Object.entries(jiraConnections).map(([name, connection]) => [
          name,
          pick(connection as RecordValue, ['baseUrl', 'doneStatusIds']),
        ]),
      ) as EditableConfig['jira']['connections'],
    },
  } as EditableConfig;
}

function readRawConfig(configPath: string): RecordValue {
  const file = path.resolve(configPath);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isRecord(raw)) return raw;
    throw new Error('Config must be a JSON object');
  } catch (error) {
    throw new ConfigError(`Cannot read config ${file}: ${(error as Error).message}`);
  }
}

function validateConfig(raw: RecordValue, file: string): z.output<ReturnType<typeof createConfigSchema>> {
  const parsed = createConfigSchema(path.dirname(file)).safeParse(raw);
  const issues = [...(parsed.success ? [] : parsed.error.issues), ...findReferenceIssues(raw)];
  if (!parsed.success || issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid config ${file}:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export function readEditableConfig(configPath: string): EditableConfig {
  const file = path.resolve(configPath);
  const raw = readRawConfig(file);
  const parsed = validateConfig(raw, file);
  const editable = projectConfig(raw, parsed.jira);
  for (const repository of Object.values(editable.repositories)) {
    (repository as RecordValue).promptAddition ??= '';
  }
  return editable;
}

function connectionKeys(value: unknown, pathName: string): RecordValue {
  if (!isRecord(value)) throw new ConfigError(`Invalid config edit: ${pathName} must be an object`);
  return value;
}

function assertSameKeys(current: RecordValue, edited: RecordValue, name: string): void {
  if (
    Object.keys(current).length !== Object.keys(edited).length ||
    Object.keys(current).some((key) => !Object.hasOwn(edited, key))
  ) {
    throw new ConfigError(`Invalid config edit: ${name} connection records cannot be added or removed`);
  }
}

function mergeConfig(raw: RecordValue, input: EditableConfig): RecordValue {
  const edited = projectConfig(input as unknown as RecordValue, input.jira);
  const currentGitlab = connectionKeys(raw.gitlab ?? {}, 'gitlab');
  const editedGitlab = connectionKeys(edited.gitlab, 'gitlab');
  const currentJira = isRecord(raw.jira) ? raw.jira : {};
  const currentJiraConnections = currentJira.connections ?? {};
  const editedJiraConnections = connectionKeys(edited.jira.connections, 'jira.connections');
  const currentJiraConnectionRecords = connectionKeys(currentJiraConnections, 'jira.connections');
  assertSameKeys(currentGitlab, editedGitlab, 'gitlab');
  assertSameKeys(currentJiraConnectionRecords, editedJiraConnections, 'jira');

  const merged = { ...raw };
  if (isRecord(edited.repositories)) {
    for (const repository of Object.values(edited.repositories) as RecordValue[]) {
      const addition = typeof repository.promptAddition === 'string' ? repository.promptAddition.trim() : '';
      if (addition === '') delete repository.promptAddition;
      else repository.promptAddition = addition;
    }
  }
  for (const field of editableFields) {
    if (Object.hasOwn(edited, field)) merged[field] = edited[field];
    else delete merged[field];
  }

  merged.gitlab = Object.fromEntries(
    Object.entries(currentGitlab).map(([name, current]) => {
      if (!isRecord(current) || !isRecord(editedGitlab[name])) {
        throw new ConfigError(`Invalid config edit: gitlab.${name} must be an object`);
      }
      return [name, { ...current, host: editedGitlab[name].host }];
    }),
  );
  merged.jira = {
    ...currentJira,
    enabled: edited.jira.enabled,
    connections: Object.fromEntries(
      Object.entries(currentJiraConnectionRecords).map(([name, current]) => {
        if (!isRecord(current) || !isRecord(editedJiraConnections[name])) {
          throw new ConfigError(`Invalid config edit: jira.connections.${name} must be an object`);
        }
        const connection: RecordValue = { ...current, baseUrl: editedJiraConnections[name].baseUrl };
        delete connection.doneStatusIds;
        if (Object.hasOwn(editedJiraConnections[name], 'doneStatusIds')) {
          connection.doneStatusIds = editedJiraConnections[name].doneStatusIds;
        }
        return [name, connection];
      }),
    ),
  };
  return merged;
}

export function writeEditableConfig(configPath: string, input: EditableConfig): void {
  const file = path.resolve(configPath);
  const raw = readRawConfig(file);
  validateConfig(raw, file);
  const merged = mergeConfig(raw, input);
  validateConfig(merged, file);
  writeJsonAtomic(file, merged);
}
