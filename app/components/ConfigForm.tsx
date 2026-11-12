'use client';

import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useId, useState, type FormEvent } from 'react';
import type { EditableConfig, ProviderName } from '@core/index';
import { saveConfig } from '../actions/config';
import { ErrorBox } from './ErrorBox';
import { providerLabel } from '../lib/providerLabel';
import { SettingsDialogActions, useSettingsDialog } from './SettingsDialog';

const PROVIDERS: ProviderName[] = ['copilot', 'claude-code', 'codex', 'opencode'];
const FIELD_ORDER: Record<string, number> = { dataDir: 0, schedule: 1 };

function label(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function updateAtPath(value: unknown, path: string[], replacement: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return replacement;
  return {
    ...value,
    [key]: rest.length === 0 ? replacement : updateAtPath((value as Record<string, unknown>)[key], rest, replacement),
  };
}

function inputId(path: string[]): string {
  return `config-${path.join('-').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function parseLines(text: string, numeric: boolean): unknown[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => (numeric && Number.isFinite(Number(line)) ? Number(line) : line));
}

// Keeps the raw text locally so temporary blank lines survive while editing.
function LinesField({
  id,
  field,
  value,
  path,
  onChange,
}: {
  id: string;
  field: string;
  value: unknown[];
  path: string[];
  onChange: (path: string[], value: unknown) => void;
}) {
  const t = useTranslations('ConfigForm');
  const numeric = field === 'days';
  const [text, setText] = useState(value.join('\n'));
  if (JSON.stringify(parseLines(text, numeric)) !== JSON.stringify(value)) setText(value.join('\n'));
  return (
    <div className="field">
      <label htmlFor={id}>{t('onePerLine', { field: label(field) })}</label>
      <textarea
        id={id}
        rows={Math.min(Math.max(value.length, 2), 8)}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(path, parseLines(event.target.value, numeric));
        }}
      />
    </div>
  );
}

function ConfigValue({
  value,
  path,
  onChange,
}: {
  value: unknown;
  path: string[];
  onChange: (path: string[], value: unknown) => void;
}) {
  const t = useTranslations('ConfigForm');
  const field = path.at(-1) ?? '';
  const id = inputId(path);

  if (path.length === 1 && path[0] === 'provider') {
    return (
      <div className="field">
        <label htmlFor={id}>{t('provider')}</label>
        <select id={id} value={String(value)} onChange={(event) => onChange(path, event.target.value)}>
          {PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {providerLabel(provider)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (Array.isArray(value)) {
    return <LinesField id={id} field={field} value={value} path={path} onChange={onChange} />;
  }

  if (typeof value === 'object' && value !== null) {
    return (
      <fieldset className="card" id={id}>
        <legend>{label(field)}</legend>
        {Object.entries(value).map(([key, child]) => (
          <ConfigValue key={key} value={child} path={[...path, key]} onChange={onChange} />
        ))}
      </fieldset>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <div className="field">
        <label className="check" htmlFor={id}>
          <input id={id} type="checkbox" checked={value} onChange={(event) => onChange(path, event.target.checked)} />
          {label(field)}
        </label>
      </div>
    );
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label(field)}</label>
      <input
        id={id}
        type={typeof value === 'number' ? 'number' : 'text'}
        value={value === undefined ? '' : String(value)}
        onChange={(event) =>
          onChange(path, typeof value === 'number' ? Number(event.target.value) : event.target.value)
        }
      />
    </div>
  );
}

export function ConfigForm({ initial }: { initial: EditableConfig }) {
  const t = useTranslations('ConfigForm');
  const formId = useId();
  const [config, setConfig] = useState(initial);
  const close = useSettingsDialog();
  const [state, formAction, pending] = useActionState(
    async (previous: Parameters<typeof saveConfig>[0], data: FormData) => {
      const result = await saveConfig(previous, data);
      if (result === null) close?.();
      return result;
    },
    null,
  );
  useSettingsDialog(pending);

  const update = (path: string[], value: unknown) => {
    setConfig((current) => updateAtPath(current, path, value) as EditableConfig);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set('config', JSON.stringify(config));
    startTransition(() => formAction(data));
  };

  return (
    <form id={formId} onSubmit={submit} className="watch-form config-form">
      {state !== null && <ErrorBox error={state.error} />}
      {Object.entries(config)
        .sort(([a], [b]) => (FIELD_ORDER[a] ?? 2) - (FIELD_ORDER[b] ?? 2))
        .map(([key, value]) => (
          <ConfigValue key={key} value={value} path={[key]} onChange={update} />
        ))}
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </button>
      </SettingsDialogActions>
    </form>
  );
}
