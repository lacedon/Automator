'use client';

import { useActionState, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { OverrideRow, Project } from '@core/index';
import {
  createProject,
  deleteProject,
  renameProject,
  setProjectConfig,
  setProjectPromptAddition,
  setProjectRepositories,
} from '../actions/projects';
import { ActionButton, ActionErrorProvider } from './ActionButton';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox } from './ErrorBox';
import { SettingsTable, SettingsTableRow } from './SettingsTable';
import { SettingsDialog, SettingsDialogActions, useSettingsDialog } from './SettingsDialog';

function ProjectEditor({ project, repositories }: { project: Project; repositories: string[] }) {
  const t = useTranslations('Projects');
  const close = useSettingsDialog();
  const [name, setName] = useState(project.name);
  const [selected, setSelected] = useState<string[]>(project.repositories);
  const [promptAddition, setPromptAddition] = useState(project.promptAddition);
  const promptId = useId();
  const toggle = (repo: string) => setSelected((s) => (s.includes(repo) ? s.filter((r) => r !== repo) : [...s, repo]));
  return (
    <ActionErrorProvider>
      <div className="project-card-head">
        <input aria-label={t('projectName')} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="project-repos">
        <legend className="muted">{t('repositories')}</legend>
        {repositories.map((repo) => (
          <label key={repo}>
            <input type="checkbox" checked={selected.includes(repo)} onChange={() => toggle(repo)} /> {repo}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={promptId}>{t('promptAddition')}</label>
        <textarea id={promptId} rows={4} value={promptAddition} onChange={(e) => setPromptAddition(e.target.value)} />
        <div className="field-hint muted">{t('promptAdditionHint')}</div>
      </div>
      <SettingsDialogActions>
        <ActionButton action={() => renameProject(project.id, name)} onDone={close}>
          {t('rename')}
        </ActionButton>
        <ActionButton
          className="btn btn-primary"
          action={() => setProjectRepositories(project.id, selected)}
          onDone={close}
        >
          {t('saveRepositories')}
        </ActionButton>
        <ActionButton
          className="btn btn-primary"
          action={() => setProjectPromptAddition(project.id, promptAddition)}
          onDone={close}
        >
          {t('savePromptAddition')}
        </ActionButton>
      </SettingsDialogActions>
    </ActionErrorProvider>
  );
}

function OverrideInput({
  row,
  value,
  onChange,
}: {
  row: OverrideRow;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('Projects');
  const label = `${row.group}: ${row.label}`;
  if (row.kind === 'select' || row.kind === 'boolean') {
    const options = row.kind === 'boolean' ? ['true', 'false'] : (row.options ?? []);
    return (
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('inheritOption', { value: row.inherited })}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={label}
      value={value}
      placeholder={
        row.inherited === '' ? t('inheritPlaceholder') : t('inheritPlaceholderValue', { value: row.inherited })
      }
      inputMode={row.kind === 'number' ? 'numeric' : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ProjectConfigEditor({ project, rows }: { project: Project; rows: OverrideRow[] }) {
  const t = useTranslations('Projects');
  const close = useSettingsDialog();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((row) => [row.id, row.override])),
  );
  const groups = [...new Set(rows.map((row) => row.group))];
  return (
    <ActionErrorProvider>
      <p className="muted">{t('configIntro')}</p>
      {groups.map((group) => (
        <fieldset key={group} className="project-config-group">
          <legend>{group}</legend>
          {rows
            .filter((row) => row.group === group)
            .map((row) => (
              <div className="field" key={row.id}>
                <label>
                  {row.label}{' '}
                  <span className="muted">{(values[row.id] ?? '') === '' ? t('inherited') : t('overridden')}</span>
                  <OverrideInput
                    row={row}
                    value={values[row.id] ?? ''}
                    onChange={(value) => setValues((current) => ({ ...current, [row.id]: value }))}
                  />
                </label>
                {row.hint !== undefined && <div className="field-hint muted">{row.hint}</div>}
                {(values[row.id] ?? '') !== '' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setValues((current) => ({ ...current, [row.id]: '' }))}
                  >
                    {t('useGlobal')}
                  </button>
                )}
              </div>
            ))}
        </fieldset>
      ))}
      <SettingsDialogActions>
        <ActionButton
          action={() => setProjectConfig(project.id, {})}
          onDone={() => {
            setValues(Object.fromEntries(rows.map((row) => [row.id, ''])));
            close?.();
          }}
        >
          {t('resetAll')}
        </ActionButton>
        <ActionButton className="btn btn-primary" action={() => setProjectConfig(project.id, values)} onDone={close}>
          {t('saveSettings')}
        </ActionButton>
      </SettingsDialogActions>
    </ActionErrorProvider>
  );
}

function NewProjectForm() {
  const t = useTranslations('Projects');
  const formId = useId();
  const close = useSettingsDialog();
  const [state, formAction, pending] = useActionState(
    async (previous: Parameters<typeof createProject>[0], data: FormData) => {
      const result = await createProject(previous, data);
      if (result === null) close?.();
      return result;
    },
    null,
  );
  useSettingsDialog(pending);
  return (
    <form id={formId} action={formAction} className="project-create">
      <input
        name="name"
        aria-label={t('projectName')}
        placeholder={t('newProjectName')}
        defaultValue={state?.values.name}
        required
      />
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          {t('createProject')}
        </button>
      </SettingsDialogActions>
      {state !== null && <ErrorBox error={state.error} />}
    </form>
  );
}

export function ProjectsManager({
  projects,
  repositories,
  projectConfigs,
}: {
  projects: Project[];
  repositories: string[];
  projectConfigs: Record<number, OverrideRow[]>;
}) {
  const t = useTranslations('Projects');
  return (
    <>
      <div className="settings-toolbar">
        <SettingsDialog title={t('newProjectTitle')} trigger={t('newProject')}>
          <NewProjectForm />
        </SettingsDialog>
      </div>
      <p className="muted">{t('belongsToOne')}</p>
      {projects.length > 0 && (
        <SettingsTable label={t('title')} headers={[t('projectCol'), t('repositories'), t('actionsCol')]}>
          {projects.map((p) => (
            <SettingsTableRow
              key={p.id}
              name={p.name}
              actions={
                <>
                  <SettingsDialog title={t('editTitle', { name: p.name })}>
                    <ProjectEditor project={p} repositories={repositories} />
                  </SettingsDialog>
                  <SettingsDialog title={t('settingsTitle', { name: p.name })} trigger={t('settings')} wide>
                    <ProjectConfigEditor project={p} rows={projectConfigs[p.id] ?? []} />
                  </SettingsDialog>
                  <ConfirmDialog
                    label={t('delete')}
                    message={t('deleteMessage', { name: p.name })}
                    confirmLabel={t('delete')}
                    danger
                    action={() => deleteProject(p.id)}
                  />
                </>
              }
            >
              <span className="muted">{p.repositories.join(' · ') || t('noRepositories')}</span>
            </SettingsTableRow>
          ))}
        </SettingsTable>
      )}
    </>
  );
}
