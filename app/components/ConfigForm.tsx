'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { EditableConfig } from '@core/index';
import { saveConfig } from '../actions/config';
import { ErrorBox } from './ErrorBox';

function label(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
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

function ConfigValue({
  value,
  path,
  onChange,
}: {
  value: unknown;
  path: string[];
  onChange: (path: string[], value: unknown) => void;
}) {
  const field = path.at(-1) ?? '';
  const id = inputId(path);

  if (Array.isArray(value)) {
    const numeric = field === 'days';
    return (
      <div className="field">
        <label htmlFor={id}>{label(field)} (one per line)</label>
        <textarea
          id={id}
          rows={Math.min(Math.max(value.length, 2), 8)}
          value={value.join('\n')}
          onChange={(event) => {
            const lines = event.target.value.split(/\r?\n/).filter((line) => line.trim() !== '');
            onChange(
              path,
              lines.map((line) => (numeric && Number.isFinite(Number(line)) ? Number(line) : line)),
            );
          }}
        />
      </div>
    );
  }

  if (typeof value === 'object' && value !== null) {
    return (
      <fieldset className="card">
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
  const [config, setConfig] = useState(initial);
  const [state, formAction, pending] = useActionState(saveConfig, null);

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
    <form onSubmit={submit} className="watch-form">
      {state !== null && <ErrorBox error={state.error} />}
      {Object.entries(config).map(([key, value]) => (
        <ConfigValue key={key} value={value} path={[key]} onChange={update} />
      ))}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Saving…' : 'Save Configuration'}
      </button>
    </form>
  );
}
