'use client';

import { useActionState, useId, useState } from 'react';
import type { Project } from '@core/index';
import { createProject, deleteProject, renameProject, setProjectRepositories } from '../actions/projects';
import { ActionButton, ActionErrorProvider } from './ActionButton';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox } from './ErrorBox';
import { SettingsTable, SettingsTableRow } from './SettingsTable';
import { SettingsDialog, SettingsDialogActions, useSettingsDialog } from './SettingsDialog';

function ProjectEditor({ project, repositories }: { project: Project; repositories: string[] }) {
  const close = useSettingsDialog();
  const [name, setName] = useState(project.name);
  const [selected, setSelected] = useState<string[]>(project.repositories);
  const toggle = (repo: string) => setSelected((s) => (s.includes(repo) ? s.filter((r) => r !== repo) : [...s, repo]));
  return (
    <ActionErrorProvider>
      <div className="project-card-head">
        <input aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="project-repos">
        <legend className="muted">Repositories</legend>
        {repositories.map((repo) => (
          <label key={repo}>
            <input type="checkbox" checked={selected.includes(repo)} onChange={() => toggle(repo)} /> {repo}
          </label>
        ))}
      </fieldset>
      <SettingsDialogActions>
        <ActionButton action={() => renameProject(project.id, name)} onDone={close}>
          Rename
        </ActionButton>
        <ActionButton
          className="btn btn-primary"
          action={() => setProjectRepositories(project.id, selected)}
          onDone={close}
        >
          Save repositories
        </ActionButton>
      </SettingsDialogActions>
    </ActionErrorProvider>
  );
}

function NewProjectForm() {
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
        aria-label="Project name"
        placeholder="New project name"
        defaultValue={state?.values.name}
        required
      />
      <SettingsDialogActions>
        <button type="submit" form={formId} className="btn btn-primary" disabled={pending}>
          Create project
        </button>
      </SettingsDialogActions>
      {state !== null && <ErrorBox error={state.error} />}
    </form>
  );
}

export function ProjectsManager({ projects, repositories }: { projects: Project[]; repositories: string[] }) {
  return (
    <>
      <div className="settings-toolbar">
        <SettingsDialog title="New Project" trigger="New project">
          <NewProjectForm />
        </SettingsDialog>
      </div>
      <p className="muted">A repository belongs to at most one Project; saving moves it from its previous Project.</p>
      {projects.length > 0 && (
        <SettingsTable label="Projects" headers={['Project', 'Repositories', 'Actions']}>
          {projects.map((p) => (
            <SettingsTableRow
              key={p.id}
              name={p.name}
              actions={
                <>
                  <SettingsDialog title={`Edit Project: ${p.name}`}>
                    <ProjectEditor project={p} repositories={repositories} />
                  </SettingsDialog>
                  <ConfirmDialog
                    label="Delete"
                    message={`Delete ${p.name}? Its repositories become unassigned; no Watches or Runs are removed.`}
                    confirmLabel="Delete"
                    danger
                    action={() => deleteProject(p.id)}
                  />
                </>
              }
            >
              <span className="muted">{p.repositories.join(' · ') || 'No Repositories assigned.'}</span>
            </SettingsTableRow>
          ))}
        </SettingsTable>
      )}
    </>
  );
}
