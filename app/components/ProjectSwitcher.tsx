'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { selectProject } from '../actions/projects';

type Props = { projects: { id: number; name: string }[]; scope: number | 'none' | null };

export function ProjectSwitcher({ projects, scope }: Props) {
  const t = useTranslations('ProjectSwitcher');
  const [pending, startTransition] = useTransition();
  return (
    <select
      className="project-switcher"
      aria-label={t('label')}
      value={scope === null ? 'all' : String(scope)}
      disabled={pending}
      onChange={(e) => {
        const value = e.target.value;
        startTransition(() => selectProject(value));
      }}
    >
      <option value="all">{t('all')}</option>
      {projects.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
        </option>
      ))}
      <option value="none">{t('unassigned')}</option>
    </select>
  );
}
