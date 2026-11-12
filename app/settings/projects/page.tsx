import { getTranslations } from 'next-intl/server';
import { ProjectsManager } from '../../components/ProjectsManager';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const core = getCore();
  const t = await getTranslations('Projects');
  const projects = core.projects.list();
  return (
    <>
      <h1 className="page-title">{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <ProjectsManager
        projects={projects}
        projectConfigs={Object.fromEntries(projects.map((p) => [p.id, core.configs.describe(p.id) ?? []]))}
        repositories={core.repositories.list().map((repository) => repository.name)}
      />
    </>
  );
}
