'use client';

import { useActionState, useState } from 'react';
import type { Project } from '@core/index';
import {
  createProject,
  deleteProject,
  renameProject,
  setProjectPromptAddition,
  setProjectRepositories,
} from '../actions/projects';
import { ActionButton, ActionErrorProvider } from './ActionButton';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBox } from './ErrorBox';

function ProjectCard({ project, repositories }: { project: Project; repositories: string[] }) {
  const [name, setName] = useState(project.name);
  const [selected, setSelected] = useState<string[]>(project.repositories);
  const [promptAddition, setPromptAddition] = useState(project.promptAddition);
  const toggle = (repo: string) => setSelected((s) => (s.includes(repo) ? s.filter((r) => r !== repo) : [...s, repo]));
  return (
    <section className="card project-card">
      <div className="project-card-head">
        <input aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <ActionButton action={() => renameProject(project.id, name)}>Rename</ActionButton>
        <ConfirmDialog
          label="Delete"
          message={`Delete ${project.name}? Its repositories become unassigned; no Watches or Runs are removed.`}
          confirmLabel="Delete"
          danger
          action={() => deleteProject(project.id)}
        />
      </div>
      <fieldset className="project-repos">
        <legend className="muted">Repositories</legend>
        {repositories.map((repo) => (
          <label key={repo}>
            <input type="checkbox" checked={selected.includes(repo)} onChange={() => toggle(repo)} /> {repo}
          </label>
        ))}
      </fieldset>
      <ActionButton className="btn btn-primary" action={() => setProjectRepositories(project.id, selected)}>
        Save repositories
      </ActionButton>
      <div className="field">
        <label htmlFor={`project-${project.id}-prompt-addition`}>Prompt addition</label>
        <textarea
          id={`project-${project.id}-prompt-addition`}
          rows={4}
          value={promptAddition}
          onChange={(e) => setPromptAddition(e.target.value)}
        />
      </div>
      <ActionButton className="btn btn-primary" action={() => setProjectPromptAddition(project.id, promptAddition)}>
        Save prompt addition
      </ActionButton>
    </section>
  );
}

export function ProjectsManager({ projects, repositories }: { projects: Project[]; repositories: string[] }) {
  const [state, formAction, pending] = useActionState(createProject, null);
  return (
    <ActionErrorProvider>
      <form action={formAction} className="project-create">
        <input name="name" placeholder="New project name" defaultValue={state?.values.name} required />
        <button className="btn btn-primary" disabled={pending}>
          Create project
        </button>
        {state !== null && <ErrorBox error={state.error} />}
      </form>
      <p className="muted">A repository belongs to at most one Project; saving moves it from its previous Project.</p>
      {projects.map((p) => (
        <ProjectCard
          key={`${p.id}:${p.name}:${p.repositories.join(',')}:${p.promptAddition}`}
          project={p}
          repositories={repositories}
        />
      ))}
    </ActionErrorProvider>
  );
}
