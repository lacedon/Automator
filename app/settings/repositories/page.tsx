import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RepositoriesManager } from '../../components/RepositoriesManager';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

export default function RepositorySettingsPage() {
  const t = useTranslations('Repositories');
  const core = getCore();
  const projects = core.projects.list();
  const repositories = core.repositories.list().map((repository) => ({
    repository,
    status: core.repositories.status(repository.name),
    projectName: projects.find((project) => project.repositories.includes(repository.name))?.name ?? null,
  }));
  const connections = {
    gitlab: Object.keys(core.config.gitlab),
    github: Object.keys(core.config.github),
    jira: Object.keys(core.config.jira.connections),
  };

  return (
    <>
      <h1 className="page-title">{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <p>
        <Link href="/settings/config">{t('openConfig')}</Link>
      </p>
      <RepositoriesManager repositories={repositories} connections={connections} />
    </>
  );
}
