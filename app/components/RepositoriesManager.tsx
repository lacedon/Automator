'use client';

import { unstable_rethrow } from 'next/navigation';
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { AppError, Repository } from '@core/index';
import { createRepository, deleteRepository, updateRepository } from '../actions/repositories';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox, errorMessage } from './ErrorBox';

type Connections = { gitlab: string[]; github: string[]; jira: string[] };
type RepositoryRow = { repository: Repository; status: string[] };

function ConnectionSelect({
  group,
  label,
  value,
  connections,
  id,
}: {
  group: keyof Connections;
  label: string;
  value: string;
  connections: Connections;
  id: string;
}) {
  const options = connections[group];
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={group} defaultValue={value}>
        <option value="">None</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

function RepositoryFields({
  id,
  repository,
  connections,
}: {
  id: string;
  repository?: Repository;
  connections: Connections;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} name="name" defaultValue={repository?.name ?? ''} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-folder`}>Local folder</label>
        <input id={`${id}-folder`} name="folder" defaultValue={repository?.folder ?? ''} required />
      </div>
      <ConnectionSelect
        group="gitlab"
        label="GitLab connection"
        id={`${id}-gitlab`}
        value={repository?.gitlab ?? ''}
        connections={connections}
      />
      <ConnectionSelect
        group="github"
        label="GitHub connection"
        id={`${id}-github`}
        value={repository?.github ?? ''}
        connections={connections}
      />
      <ConnectionSelect
        group="jira"
        label="Jira connection"
        id={`${id}-jira`}
        value={repository?.jira ?? ''}
        connections={connections}
      />
      <div className="field">
        <label htmlFor={`${id}-validate`}>Validation commands</label>
        <textarea id={`${id}-validate`} name="validate" rows={3} defaultValue={repository?.validate.join('\n') ?? ''} />
        <div className="field-hint muted">One command per line. Leave blank for no validation commands.</div>
      </div>
    </>
  );
}

function inputFromForm(form: HTMLFormElement): Repository {
  const data = new FormData(form);
  const text = (key: string) => {
    const value = data.get(key);
    return typeof value === 'string' ? value : '';
  };
  return {
    name: text('name'),
    folder: text('folder'),
    gitlab: text('gitlab') || null,
    github: text('github') || null,
    jira: text('jira') || null,
    validate: text('validate')
      .split(/\r?\n/)
      .map((command) => command.trim())
      .filter(Boolean),
  };
}

function CreateRepository({ connections }: { connections: Connections }) {
  const [state, formAction, pending] = useActionState(createRepository, null);
  const defaults = state?.values;
  const values: Repository | undefined =
    defaults === undefined
      ? undefined
      : {
          ...defaults,
          gitlab: defaults.gitlab ?? null,
          github: defaults.github ?? null,
          jira: defaults.jira ?? null,
        };
  return (
    <section className="card">
      <h2 className="card-title">Add Repository</h2>
      <form action={formAction}>
        {state !== null && <ErrorBox error={state.error} />}
        <RepositoryFields id="new-repository" repository={values} connections={connections} />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Add Repository
        </button>
      </form>
    </section>
  );
}

function RepositoryCard({
  repository,
  status,
  connections,
  index,
}: RepositoryRow & { connections: Connections; index: number }) {
  const [error, setError] = useState<AppError | string | null>(null);
  const [pending, setPending] = useState(false);
  const id = `repository-${index}`;
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputFromForm(event.currentTarget);
    setPending(true);
    startTransition(async () => {
      try {
        const result = await updateRepository(repository.name, input);
        setError(result.ok ? null : result.error);
      } catch (cause) {
        unstable_rethrow(cause);
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    });
  };

  return (
    <section className="card">
      <h2 className="card-title">{repository.name}</h2>
      {status.length > 0 && (
        <p className="field-hint" role="status">
          Repository setup needs attention: {status.join('; ')}
        </p>
      )}
      <form onSubmit={save}>
        {error !== null && <ErrorBox error={error} />}
        <RepositoryFields id={id} repository={repository} connections={connections} />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Save Repository
        </button>
      </form>
      <div className="field">
        <ConfirmDialog
          danger
          label="Delete Repository"
          confirmLabel="Delete Repository"
          message={`Delete Repository "${repository.name}"? A Repository with Watches cannot be deleted. This removes only its settings. Local files are never deleted.`}
          action={() => deleteRepository(repository.name)}
        />
      </div>
    </section>
  );
}

export function RepositoriesManager({
  repositories,
  connections,
}: {
  repositories: RepositoryRow[];
  connections: Connections;
}) {
  return (
    <>
      <CreateRepository connections={connections} />
      <h2 className="section-h">Repositories</h2>
      {repositories.map((row, index) => (
        <RepositoryCard key={row.repository.name} {...row} connections={connections} index={index} />
      ))}
    </>
  );
}
