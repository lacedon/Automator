'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { FormOptions } from '@core/index';
import { queueAdhoc, type AdhocFormState } from '../actions/adhoc';
import { ErrorBox } from './ErrorBox';

export function AdhocForm({ options }: { options: Pick<FormOptions, 'repositories' | 'models' | 'defaultModel'> }) {
  const [state, formAction, pending] = useActionState(queueAdhoc, null);
  const [repository, setRepository] = useState(options.repositories[0]?.name ?? '');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');

  // A successful submit clears the prompt for the next Run; failures keep everything as entered.
  const [seen, setSeen] = useState<AdhocFormState>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setPrompt('');
  }

  // Submitting manually avoids React's automatic form reset, which would revert the controlled selects.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };

  const repo = options.repositories.find((r) => r.name === repository);
  const otherModels = options.models.filter((m) => m !== options.defaultModel);
  const failed = state?.ok === false ? state.error : null;
  const inputClass = (field: string) =>
    (failed?.code === 'UNKNOWN_REPOSITORY' && field === 'repository') || (failed?.code === 'INVALID_INPUT' && failed.field === field)
      ? 'input-err'
      : undefined;

  return (
    <form action={formAction} onSubmit={submit} className="watch-form">
      {failed !== null && <ErrorBox error={failed} unknownRepositoryOutcome="No Run was queued." />}
      {state?.ok && (
        <div className="success-box" role="status">
          Run #{state.value.runId} queued{state.value.position !== null && ` (position ${state.value.position})`}
        </div>
      )}
      <div className="field">
        <label htmlFor="ah-repository">Repository</label>
        <select
          id="ah-repository"
          name="repository"
          className={inputClass('repository')}
          value={repository}
          onChange={(e) => setRepository(e.target.value)}
        >
          {repo === undefined && <option value={repository}>{repository}</option>}
          {options.repositories.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        {repo !== undefined && <div className="field-hint muted mono">{repo.folder}</div>}
      </div>
      <div className="field">
        <label htmlFor="ah-prompt">Prompt</label>
        <textarea
          id="ah-prompt"
          name="prompt"
          rows={4}
          required
          className={inputClass('prompt')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What Copilot should do in this Repository…"
        />
      </div>
      <div className="field field-narrow">
        <label htmlFor="ah-model">Model</label>
        <select id="ah-model" name="model" className={inputClass('model')} value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">default ({options.defaultModel})</option>
          {otherModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Queue run
        </button>
        <span className="muted">Goes ahead of scheduled work, ignores working hours, never interrupts the current Run.</span>
      </div>
    </form>
  );
}
