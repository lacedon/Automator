import type { ProjectScope } from '../domain/types';
import type { ReadDeps } from './deps';

// Work belongs to a Project through its repository; repositories without a Project are 'none'.
export function scopeFilter({ db }: ReadDeps, scope: ProjectScope): (repository: string) => boolean {
  if (scope === null) return () => true;
  const rows = db.prepare('SELECT repository, project_id FROM project_repositories').all() as {
    repository: string;
    project_id: number;
  }[];
  const projectOf = new Map(rows.map((r) => [r.repository, r.project_id]));
  if (typeof scope === 'object')
    return (repository) => {
      const project = projectOf.get(repository);
      return project === undefined ? scope.unassigned : scope.projects.includes(project);
    };
  return scope === 'none'
    ? (repository) => !projectOf.has(repository)
    : (repository) => projectOf.get(repository) === scope;
}
