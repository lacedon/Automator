import { ProjectsManager } from '../../components/ProjectsManager';
import { getCore } from '../../lib/core';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  const core = getCore();
  return (
    <>
      <h1 className="page-title">Projects</h1>
      <p className="muted">Group repositories. Use the top bar to switch your working scope.</p>
      <ProjectsManager projects={core.projects.list()} repositories={Object.keys(core.config.repositories)} />
    </>
  );
}
