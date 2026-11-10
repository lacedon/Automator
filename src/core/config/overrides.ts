import { formatDuration, parseDuration } from '../domain/duration';
import type { ProviderName } from '../domain/types';
import type { Config } from './schema';

// Project overrides are a sparse map of field id -> text value; an absent or blank value inherits the global one.
export type OverrideValues = Record<string, string>;

export type OverrideKind = 'text' | 'number' | 'boolean' | 'list' | 'select';

export interface OverrideField {
  id: string;
  group: string;
  label: string;
  kind: OverrideKind;
  options?: string[];
  hint?: string;
  read(config: Config): string;
  // Writes the parsed value into a draft config; returns an error message when the value is invalid.
  apply(draft: Config, value: string): string | null;
}

export type OverrideRow = Pick<OverrideField, 'id' | 'group' | 'label' | 'kind' | 'options' | 'hint'> & {
  inherited: string;
  override: string;
};

export type OverrideErrors = Record<string, string>;

const PROVIDERS: ProviderName[] = ['copilot', 'claude-code', 'codex', 'opencode'];
const SEPARATE_PROVIDERS = ['claude-code', 'codex', 'opencode'] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_TEAMS_TOOL = 'teams-global(send_chat_message)';
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:4317';

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

function positiveInt(value: string): number | null {
  return /^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value) : null;
}

function text(
  id: string,
  group: string,
  label: string,
  read: OverrideField['read'],
  write: (draft: Config, value: string) => void,
  validate?: (value: string) => string | null,
  hint?: string,
): OverrideField {
  return {
    id,
    group,
    label,
    kind: 'text',
    hint,
    read,
    apply(draft, value) {
      const error = validate?.(value) ?? null;
      if (error === null) write(draft, value);
      return error;
    },
  };
}

function envName(
  id: string,
  group: string,
  label: string,
  read: OverrideField['read'],
  write: (draft: Config, value: string) => void,
): OverrideField {
  return text(
    id,
    group,
    label,
    read,
    write,
    (value) => (ENV_NAME.test(value) ? null : 'Expected an environment variable name, not a secret value'),
    'Name of the environment variable that holds the secret',
  );
}

function duration(key: 'mr' | 'default', label: string): OverrideField {
  return {
    id: `schedule/intervals/${key}`,
    group: 'Schedule',
    label,
    kind: 'text',
    hint: 'e.g. 90s, 15m, 2h, 1d',
    read: (config) => formatDuration(config.schedule.intervals[key]),
    apply(draft, value) {
      let ms: number;
      try {
        ms = parseDuration(value);
      } catch {
        return `Invalid duration "${value}" (expected e.g. 90s, 15m, 2h, 1d)`;
      }
      if (ms <= 0) return 'Duration must be greater than zero';
      draft.schedule.intervals[key] = ms;
      return null;
    },
  };
}

function connectionFields(base: Config): OverrideField[] {
  const fields: OverrideField[] = [];
  for (const name of Object.keys(base.gitlab)) {
    fields.push(
      envName(
        `gitlab/${name}/tokenEnv`,
        'GitLab',
        `${name}: token variable`,
        (config) => config.gitlab[name]?.tokenEnv ?? '',
        (draft, value) => {
          draft.gitlab[name]!.tokenEnv = value;
        },
      ),
    );
  }
  for (const name of Object.keys(base.github)) {
    fields.push(
      envName(
        `github/${name}/tokenEnv`,
        'GitHub',
        `${name}: token variable`,
        (config) => config.github[name]?.tokenEnv ?? '',
        (draft, value) => {
          draft.github[name]!.tokenEnv = value;
        },
      ),
    );
  }
  for (const name of Object.keys(base.jira.connections)) {
    fields.push(
      envName(
        `jira/${name}/emailEnv`,
        'Jira',
        `${name}: email variable`,
        (config) => config.jira.connections[name]?.emailEnv ?? '',
        (draft, value) => {
          draft.jira.connections[name]!.emailEnv = value;
        },
      ),
      envName(
        `jira/${name}/tokenEnv`,
        'Jira',
        `${name}: token variable`,
        (config) => config.jira.connections[name]?.tokenEnv ?? '',
        (draft, value) => {
          draft.jira.connections[name]!.tokenEnv = value;
        },
      ),
    );
  }
  return fields;
}

function teamsField(key: 'chatId' | 'tool' | 'model' | 'dashboardUrl', label: string, hint?: string): OverrideField {
  return text(
    `teams/${key}`,
    'Teams',
    label,
    (config) => config.teams?.[key] ?? '',
    (draft, value) => {
      draft.teams ??= { chatId: '', tool: DEFAULT_TEAMS_TOOL, dashboardUrl: DEFAULT_DASHBOARD_URL };
      draft.teams[key] = value;
    },
    undefined,
    hint,
  );
}

export function overrideFields(base: Config): OverrideField[] {
  return [
    duration('mr', 'Merge request check interval'),
    duration('default', 'Default check interval'),
    {
      id: 'schedule/workingHours/days',
      group: 'Schedule',
      label: 'Working days',
      kind: 'list',
      hint: 'Comma-separated, 0 (Sunday) to 6 (Saturday)',
      read: (c) => c.schedule.workingHours.days.join(', '),
      apply(draft, value) {
        const days = splitList(value).map(Number);
        if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
          return 'Days must be integers from 0 to 6';
        draft.schedule.workingHours.days = days;
        return null;
      },
    },
    text(
      'schedule/workingHours/start',
      'Schedule',
      'Working hours start',
      (c) => c.schedule.workingHours.start,
      (draft, value) => {
        draft.schedule.workingHours.start = value;
      },
      (value) => (CLOCK.test(value) ? null : 'Expected HH:MM (24h)'),
    ),
    text(
      'schedule/workingHours/end',
      'Schedule',
      'Working hours end',
      (c) => c.schedule.workingHours.end,
      (draft, value) => {
        draft.schedule.workingHours.end = value;
      },
      (value) => (CLOCK.test(value) ? null : 'Expected HH:MM (24h)'),
    ),
    text(
      'copilotBin',
      'Copilot Bin',
      'Copilot executable',
      (c) => c.copilotBin,
      (draft, value) => {
        draft.copilotBin = value;
      },
    ),
    {
      id: 'provider',
      group: 'Provider',
      label: 'Provider',
      kind: 'select',
      options: PROVIDERS,
      read: (c) => c.provider,
      apply(draft, value) {
        if (!PROVIDERS.includes(value as ProviderName)) return `Unknown provider "${value}"`;
        draft.provider = value as ProviderName;
        return null;
      },
    },
    ...SEPARATE_PROVIDERS.map((provider) =>
      text(
        `providers/${provider}/bin`,
        'Provider',
        `${provider} executable`,
        (c) => c.providers[provider].bin,
        (draft, value) => {
          draft.providers[provider].bin = value;
        },
      ),
    ),
    {
      id: 'runs/timeoutMinutes',
      group: 'Runs',
      label: 'Run timeout (minutes)',
      kind: 'number',
      read: (c) => String(c.runs.timeoutMs / 60_000),
      apply(draft, value) {
        const minutes = positiveInt(value);
        if (minutes === null) return 'Expected a positive whole number';
        draft.runs.timeoutMs = minutes * 60_000;
        return null;
      },
    },
    text(
      'runs/defaultModel',
      'Runs',
      'Default model',
      (c) => c.runs.defaultModel,
      (draft, value) => {
        draft.runs.defaultModel = value;
      },
    ),
    {
      id: 'runs/models',
      group: 'Runs',
      label: 'Models',
      kind: 'list',
      hint: 'Comma-separated',
      read: (c) => c.runs.models.join(', '),
      apply(draft, value) {
        draft.runs.models = splitList(value);
        return null;
      },
    },
    {
      id: 'runs/initialReview',
      group: 'Runs',
      label: 'Initial review',
      kind: 'select',
      options: ['baseline-only', 'unresolved'],
      read: (c) => c.runs.initialReview,
      apply(draft, value) {
        if (value !== 'baseline-only' && value !== 'unresolved') return `Unknown initial review "${value}"`;
        draft.runs.initialReview = value;
        return null;
      },
    },
    {
      id: 'runs/denyTools',
      group: 'Runs',
      label: 'Denied tools',
      kind: 'list',
      hint: 'Comma-separated',
      read: (c) => c.runs.denyTools.join(', '),
      apply(draft, value) {
        draft.runs.denyTools = splitList(value);
        return null;
      },
    },
    {
      id: 'cleanup/enabled',
      group: 'Cleanup',
      label: 'Enabled',
      kind: 'boolean',
      read: (c) => String(c.cleanup.enabled),
      apply(draft, value) {
        if (value !== 'true' && value !== 'false') return 'Expected true or false';
        draft.cleanup.enabled = value === 'true';
        return null;
      },
    },
    {
      id: 'cleanup/everyDays',
      group: 'Cleanup',
      label: 'Every days',
      kind: 'number',
      read: (c) => String(c.cleanup.everyDays),
      apply(draft, value) {
        const days = positiveInt(value);
        if (days === null) return 'Expected a positive whole number';
        draft.cleanup.everyDays = days;
        return null;
      },
    },
    {
      id: 'cleanup/retainClosedDays',
      group: 'Cleanup',
      label: 'Retain closed days',
      kind: 'number',
      read: (c) => String(c.cleanup.retainClosedDays),
      apply(draft, value) {
        const days = positiveInt(value);
        if (days === null) return 'Expected a positive whole number';
        draft.cleanup.retainClosedDays = days;
        return null;
      },
    },
    teamsField('chatId', 'Chat ID'),
    teamsField('tool', 'Tool'),
    teamsField('model', 'Model'),
    teamsField('dashboardUrl', 'Dashboard URL'),
    ...connectionFields(base),
    {
      id: 'jira/enabled',
      group: 'Jira',
      label: 'Enabled',
      kind: 'boolean',
      read: (c) => String(c.jira.enabled),
      apply(draft, value) {
        if (value !== 'true' && value !== 'false') return 'Expected true or false';
        draft.jira.enabled = value === 'true';
        return null;
      },
    },
  ];
}

function sanitize(base: Config, values: OverrideValues): OverrideValues {
  const known = new Set(overrideFields(base).map((field) => field.id));
  return Object.fromEntries(
    Object.entries(values)
      .map(([id, value]) => [id, typeof value === 'string' ? value.trim() : ''] as const)
      .filter(([id, value]) => value !== '' && known.has(id)),
  );
}

function mergedErrors(config: Config): OverrideErrors {
  const errors: OverrideErrors = {};
  const { days, start, end } = config.schedule.workingHours;
  if (days.length === 0) errors['schedule/workingHours/days'] = 'At least one working day is required';
  else if (new Set(days).size !== days.length) errors['schedule/workingHours/days'] = 'Working days must not repeat';
  if (start >= end) errors['schedule/workingHours/end'] = `Must be later than start (${start})`;
  if (config.provider !== 'copilot' && config.providers[config.provider].defaultModel.trim() === '') {
    errors.provider = `A default model is required for provider "${config.provider}"`;
  }
  if (config.teams !== undefined && config.teams.chatId === '') {
    errors['teams/chatId'] = 'Chat ID is required when Teams notifications are configured';
  }
  return errors;
}

// Applies the overrides field by field over the global config; blank or stale entries are skipped.
export function applyOverrides(
  base: Config,
  values: OverrideValues,
): { ok: true; config: Config; values: OverrideValues } | { ok: false; errors: OverrideErrors } {
  const clean = sanitize(base, values);
  const draft = structuredClone(base);
  const errors: OverrideErrors = {};
  for (const field of overrideFields(base)) {
    const value = clean[field.id];
    if (value === undefined) continue;
    const error = field.apply(draft, value);
    if (error !== null) errors[field.id] = error;
  }
  if (Object.keys(errors).length === 0) Object.assign(errors, mergedErrors(draft));
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, config: draft, values: clean };
}

export function unknownOverrideIds(base: Config, values: OverrideValues): string[] {
  const known = new Set(overrideFields(base).map((field) => field.id));
  return Object.keys(values).filter((id) => !known.has(id));
}

export function describeOverrides(base: Config, values: OverrideValues): OverrideRow[] {
  const clean = sanitize(base, values);
  return overrideFields(base).map(({ id, group, label, kind, options, hint, read }) => ({
    id,
    group,
    label,
    kind,
    options,
    hint,
    inherited: read(base),
    override: clean[id] ?? '',
  }));
}
