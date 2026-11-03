import { ProjectsManager } from '../components/ProjectsManager';
import { getCore } from '../lib/core';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  const core = getCore();
  return (
    <>
      <h1 className="page-title">Projects</h1>
      <p className="muted">Group repositories into Projects and switch between them from the top bar.</p>
      <ProjectsManager projects={core.projects.list()} repositories={Object.keys(core.config.repositories)} />
    </>
  );
}
