'use client';

import { unstable_rethrow } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useId, useState, type FormEvent } from 'react';
import type { AppError, Repository } from '@core/index';
import { createRepository, deleteRepository, updateRepository } from '../actions/repositories';
import { repositoryFromForm } from '../lib/repositoryForm';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox, errorMessage } from './ErrorBox';
import { SettingsTable, SettingsTableRow } from './SettingsTable';
import { SettingsDialog, SettingsDialogActions, useSettingsDialog } from './SettingsDialog';

type Connections = { gitlab: string[]; github: string[]; jira: string[] };
type RepositoryRow = { repository: Repository; status: string[]; projectName: string | null };

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
  const t = useTranslations('Repositories');
  const options = connections[group];
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={group} defaultValue={value}>
        <option value="">{t('none')}</option>
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
  const t = useTranslations('Repositories');
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-name`}>{t('name')}</label>
        <input id={`${id}-name`} name="name" defaultValue={repository?.name ?? ''} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-folder`}>{t('folder')}</label>
        <input id={`${id}-folder`} name="folder" defaultValue={repository?.folder ?? ''} required />
      </div>
      <ConnectionSelect
        group="gitlab"
        label={t('gitlabConnection')}
        id={`${id}-gitlab`}
        value={repository?.gitlab ?? ''}
        connections={connections}
      />
      <ConnectionSelect
        group="github"
        label={t('githubConnection')}
        id={`${id}-github`}
        value={repository?.github ?? ''}
        connections={connections}
      />
      <ConnectionSelect
        group="jira"
        label={t('jiraConnection')}
        id={`${id}-jira`}
        value={repository?.jira ?? ''}
        connections={connections}
      />
      <div className="field">
        <label htmlFor={`${id}-validate`}>{t('validate')}</label>
        <textarea id={`${id}-validate`} name="validate" rows={3} defaultValue={repository?.validate.join('\n') ?? ''} />
        <div className="field-hint muted">{t('validateHint')}</div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-prompt-addition`}>{t('promptAddition')}</label>
        <textarea
          id={`${id}-prompt-addition`}
          name="promptAddition"
          rows={3}
          defaultValue={repository?.promptAddition ?? ''}
        />
        <div className="field-hint muted">{t('promptAdditionHint')}</div>
      </div>
    </>
  );
}

function CreateRepository({ connections }: { connections: Connections }) {
  const t = useTranslations('Repositories');
  const formId = useId();
  const close = useSettingsDialog();
  const [state, formAction, pending] = useActionState(
    async (previous: Parameters<typeof createRepository>[0], data: FormData) => {
      const result = await createRepository(previous, data);
      if (result === null) close?.();
      return result;
    },
    null,
  );
  useSettingsDialog(pending);
  const defaults = state?.values;
  const values: Repository | undefined =
    defaults === undefined
      ? undefined
      : {
          ...defaults,
          promptAddition: defaults.promptAddition ?? '',
          gitlab: defaults.gitlab ?? null,
          github: defaults.github ?? null,
          jira: defaults.jira ?? null,
        };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };
  return (
    <form id={formId} onSubmit={submit}>
      {state !== null && <ErrorBox error={state.error} />}
      <RepositoryFields id="new-repository" repository={values} connections={connections} />
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {t('add')}
        </button>
      </SettingsDialogActions>
    </form>
  );
}

function RepositoryEditForm({
  repository,
  connections,
  index,
}: {
  repository: Repository;
  connections: Connections;
  index: number;
}) {
  const t = useTranslations('Repositories');
  const formId = useId();
  const [error, setError] = useState<AppError | string | null>(null);
  const [pending, setPending] = useState(false);
  const close = useSettingsDialog(pending);
  const id = `repository-${index}`;
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = repositoryFromForm(new FormData(event.currentTarget));
    setPending(true);
    startTransition(async () => {
      try {
        const result = await updateRepository(repository.name, input);
        setError(result.ok ? null : result.error);
        if (result.ok) close?.();
      } catch (cause) {
        unstable_rethrow(cause);
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    });
  };

  return (
    <form id={formId} onSubmit={save}>
      {error !== null && <ErrorBox error={error} />}
      <RepositoryFields id={id} repository={repository} connections={connections} />
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {t('save')}
        </button>
      </SettingsDialogActions>
    </form>
  );
}

function RepositoryCard({
  repository,
  status,
  projectName,
  connections,
  index,
}: RepositoryRow & { connections: Connections; index: number }) {
  const t = useTranslations('Repositories');
  return (
    <SettingsTableRow
      name={repository.name}
      actions={
        <>
          <SettingsDialog title={t('editTitle', { name: repository.name })}>
            <RepositoryEditForm repository={repository} connections={connections} index={index} />
          </SettingsDialog>
          <ConfirmDialog
            danger
            label={t('delete')}
            confirmLabel={t('delete')}
            message={t('deleteMessage', { name: repository.name })}
            action={() => deleteRepository(repository.name)}
          />
        </>
      }
    >
      <p className="muted">{repository.folder}</p>
      <p className="muted">
        {t('project', { name: projectName ?? t('unassigned') })} ·{' '}
        <Link href="/settings/projects">{t('manageMembership')}</Link>
      </p>
      <p className="muted">
        {[
          repository.gitlab && `GitLab: ${repository.gitlab}`,
          repository.github && `GitHub: ${repository.github}`,
          repository.jira && `Jira: ${repository.jira}`,
        ]
          .filter(Boolean)
          .join(' · ') || t('noConnections')}
      </p>
      {status.length > 0 && (
        <p className="field-hint" role="status">
          {t('needsAttention', { status: status.join('; ') })}
        </p>
      )}
    </SettingsTableRow>
  );
}

export function RepositoriesManager({
  repositories,
  connections,
}: {
  repositories: RepositoryRow[];
  connections: Connections;
}) {
  const t = useTranslations('Repositories');
  return (
    <>
      <div className="settings-toolbar">
        <SettingsDialog title={t('add')} trigger={t('add')}>
          <CreateRepository connections={connections} />
        </SettingsDialog>
      </div>
      {repositories.length === 0 && <p className="muted">{t('empty')}</p>}
      {repositories.length > 0 && (
        <SettingsTable label={t('title')} headers={[t('repositoryCol'), t('detailsCol'), t('actionsCol')]}>
          {repositories.map((row, index) => (
            <RepositoryCard key={row.repository.name} {...row} connections={connections} index={index} />
          ))}
        </SettingsTable>
      )}
    </>
  );
}
