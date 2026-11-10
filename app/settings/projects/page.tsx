import { ProjectsManager } from '../../components/ProjectsManager';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  const core = getCore();
  const projects = core.projects.list();
  return (
    <>
      <h1 className="page-title">Projects</h1>
      <p className="muted">Group repositories. Use the top bar to switch your working scope.</p>
      <ProjectsManager
        projects={projects}
        projectConfigs={Object.fromEntries(projects.map((p) => [p.id, core.configs.describe(p.id) ?? []]))}
        repositories={core.repositories.list().map((repository) => repository.name)}
      />
    </>
  );
}
