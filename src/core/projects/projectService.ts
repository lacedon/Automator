import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';
import type { Project } from '../domain/types';

type Row = Record<string, unknown>;

// A repository belongs to at most one Project, so work is never shown under two Projects at once.
export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Project[] {
    const byProject = new Map<number, string[]>();
    const assignments = this.db
      .prepare('SELECT project_id, repository FROM project_repositories ORDER BY repository')
      .all() as Row[];
    for (const a of assignments) {
      const id = a.project_id as number;
      byProject.set(id, [...(byProject.get(id) ?? []), a.repository as string]);
    }
    return (this.db.prepare('SELECT id, name FROM projects ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      repositories: byProject.get(r.id as number) ?? [],
    }));
  }

  get(id: number): Project | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  projectOf(): Map<string, number> {
    const rows = this.db.prepare('SELECT repository, project_id FROM project_repositories').all() as Row[];
    return new Map(rows.map((r) => [r.repository as string, r.project_id as number]));
  }

  create(name: string): Result<Project> {
    const valid = this.validName(name);
    if (!valid.ok) return valid;
    if (this.nameTaken(valid.value)) return err({ code: 'INVALID_INPUT', field: 'name', message: 'Name is taken' });
    const row = this.db
      .prepare('INSERT INTO projects (name, created_at) VALUES (?, ?) RETURNING id')
      .get(valid.value, this.now()) as { id: number };
    return ok({ id: row.id, name: valid.value, repositories: [] });
  }

  rename(id: number, name: string): Result<Project> {
    const valid = this.validName(name);
    if (!valid.ok) return valid;
    if (this.get(id) === null) return err({ code: 'NOT_FOUND' });
    if (this.nameTaken(valid.value, id)) {
      return err({ code: 'INVALID_INPUT', field: 'name', message: 'Name is taken' });
    }
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(valid.value, id);
    return ok(this.get(id)!);
  }

  // Deleting a Project leaves its repositories unassigned; no work is removed.
  delete(id: number): Result<void> {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes === 0 ? err({ code: 'NOT_FOUND' }) : ok(undefined);
  }

  // Replaces the Project's repositories; a repository listed here is moved out of any other Project.
  setRepositories(id: number, repositories: string[]): Result<Project> {
    if (this.get(id) === null) return err({ code: 'NOT_FOUND' });
    const known = Object.keys(this.config.repositories);
    const unique = [...new Set(repositories)];
    const unknown = unique.find((r) => !known.includes(r));
    if (unknown !== undefined) {
      return err({ code: 'UNKNOWN_REPOSITORY', name: unknown, known, attemptFile: null });
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_repositories WHERE project_id = ?').run(id);
      const upsert = this.db.prepare(
        `INSERT INTO project_repositories (repository, project_id) VALUES (?, ?)
         ON CONFLICT (repository) DO UPDATE SET project_id = excluded.project_id`,
      );
      for (const repository of unique) upsert.run(repository, id);
    })();
    return ok(this.get(id)!);
  }

  private validName(name: string): Result<string> {
    const trimmed = name.trim();
    return trimmed === '' ? err({ code: 'INVALID_INPUT', field: 'name', message: 'Name is required' }) : ok(trimmed);
  }

  private nameTaken(name: string, exceptId?: number): boolean {
    const row = this.db.prepare('SELECT id FROM projects WHERE name = ?').get(name) as { id: number } | undefined;
    return row !== undefined && row.id !== exceptId;
  }
}
