import Link from 'next/link';
import { RepositoriesManager } from '../../components/RepositoriesManager';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

export default function RepositorySettingsPage() {
  const core = getCore();
  const repositories = core.repositories.list().map((repository) => ({
    repository,
    status: core.repositories.status(repository.name),
  }));
  const connections = {
    gitlab: Object.keys(core.config.gitlab),
    github: Object.keys(core.config.github),
    jira: Object.keys(core.config.jira.connections),
  };

  return (
    <>
      <h1 className="page-title">Repository Settings</h1>
      <p className="muted">
        Manage Repository folders and connection references. Credentials remain in the application configuration and
        environment.
      </p>
      <p>
        <Link href="/settings/config">Open Configuration →</Link>
      </p>
      <RepositoriesManager repositories={repositories} connections={connections} />
    </>
  );
}
