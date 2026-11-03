'use client';

import { useTransition } from 'react';
import { selectProject } from '../actions/projects';

type Props = { projects: { id: number; name: string }[]; scope: number | 'none' | null };

export function ProjectSwitcher({ projects, scope }: Props) {
  const [pending, startTransition] = useTransition();
  return (
    <select
      className="project-switcher"
      aria-label="Project"
      value={scope === null ? 'all' : String(scope)}
      disabled={pending}
      onChange={(e) => {
        const value = e.target.value;
        startTransition(() => selectProject(value));
      }}
    >
      <option value="all">All projects</option>
      {projects.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
        </option>
      ))}
      <option value="none">Unassigned</option>
    </select>
  );
}
