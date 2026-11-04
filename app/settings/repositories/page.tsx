import Link from 'next/link';
import { EmptyState } from '../../components/EmptyState';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

export default function RepositoriesPage() {
  const core = getCore();
  const repositories = core.read.formOptions().repositories;
  const projects = core.projects.list();
  return (
    <>
      <h1 className="page-title">Repositories</h1>
      <p className="muted">Local folders, service connections and project membership.</p>
      <p>
        <Link href="/settings/config#config-repositories" className="btn btn-secondary">
          Edit repository configuration
        </Link>
      </p>
      {repositories.length === 0 && <EmptyState>No repositories configured.</EmptyState>}
      {repositories.map((repository) => {
        const config = core.config.repositories[repository.name]!;
        const project = projects.find((p) => p.repositories.includes(repository.name));
        return (
          <section className="card repository-card" key={repository.name} aria-label={repository.name}>
            <h2>{repository.name}</h2>
            <dl className="kv">
              <dt>Folder</dt>
              <dd>{repository.folder}</dd>
              <dt>Project</dt>
              <dd>{project?.name ?? 'Unassigned'}</dd>
              <dt>Connections</dt>
              <dd>
                {[
                  config.gitlab && `GitLab: ${config.gitlab}`,
                  config.github && `GitHub: ${config.github}`,
                  config.jira && `Jira: ${config.jira}`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'None'}
              </dd>
            </dl>
            <Link href="/settings/projects" className="repository-project-link">
              Manage project membership
            </Link>
          </section>
        );
      })}
      <p className="muted">Repository configuration changes take effect after an application restart.</p>
    </>
  );
}
