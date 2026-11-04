import fs from 'node:fs';
import type { Config } from '../config/schema';
import { resolvePath } from '../config/schema';
import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';

export type Repository = {
  name: string;
  folder: string;
  gitlab: string | null;
  github: string | null;
  jira: string | null;
  validate: string[];
};

export type RepositoryInput = Repository;
export type RepositoryReader = Pick<RepositoryService, 'get'>;

type RepositoryRow = Omit<Repository, 'validate'> & { validate_json: string };
type RepositoryConfig = Pick<Config, 'configDir' | 'gitlab' | 'github' | 'jira'>;

const invalid = (field: string, message: string): Result<never> => err({ code: 'INVALID_INPUT', field, message });

export class RepositoryService {
  constructor(
    private readonly db: Database,
    private readonly config: RepositoryConfig,
  ) {}

  list(): Repository[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY name COLLATE NOCASE').all() as RepositoryRow[]).map(
      (row) => this.fromRow(row),
    );
  }

  get(name: string): Repository | null {
    const row = this.db.prepare('SELECT * FROM repositories WHERE name = ? COLLATE NOCASE').get(name) as
      RepositoryRow | undefined;
    return row === undefined ? null : this.fromRow(row);
  }

  status(name: string): string[] {
    const repository = this.get(name);
    if (repository === null) return ['Repository not found'];
    const issues: string[] = [];
    if (repository.gitlab === null && repository.github === null) {
      issues.push('A repository needs a GitLab or GitHub connection');
    }
    try {
      if (!fs.statSync(repository.folder).isDirectory()) issues.push(`Folder is not a directory: ${repository.folder}`);
    } catch {
      issues.push(`Folder does not exist: ${repository.folder}`);
    }
    if (repository.gitlab !== null && !Object.hasOwn(this.config.gitlab, repository.gitlab)) {
      issues.push(`Unknown GitLab connection "${repository.gitlab}"`);
    }
    if (repository.github !== null && !Object.hasOwn(this.config.github, repository.github)) {
      issues.push(`Unknown GitHub connection "${repository.github}"`);
    }
    if (repository.jira !== null && !Object.hasOwn(this.config.jira.connections, repository.jira)) {
      issues.push(`Unknown Jira connection "${repository.jira}"`);
    }
    return issues;
  }

  create(input: RepositoryInput): Result<Repository> {
    const valid = this.validate(input);
    if (!valid.ok) return valid;
    if (this.get(valid.value.name) !== null) return invalid('name', 'Name is already in use');
    this.db
      .prepare(
        `INSERT INTO repositories (name, folder, gitlab, github, jira, validate_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.value.name,
        valid.value.folder,
        valid.value.gitlab,
        valid.value.github,
        valid.value.jira,
        JSON.stringify(valid.value.validate),
      );
    return ok(valid.value);
  }

  update(name: string, input: RepositoryInput): Result<Repository> {
    const existing = this.get(name);
    if (existing === null) return err({ code: 'NOT_FOUND' });
    const valid = this.validate(input);
    if (!valid.ok) return valid;
    if (valid.value.name.toLowerCase() !== existing.name.toLowerCase() && this.get(valid.value.name)) {
      return invalid('name', 'Name is already in use');
    }
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE repositories SET name = ?, folder = ?, gitlab = ?, github = ?, jira = ?, validate_json = ?
             WHERE name = ?`,
          )
          .run(
            valid.value.name,
            valid.value.folder,
            valid.value.gitlab,
            valid.value.github,
            valid.value.jira,
            JSON.stringify(valid.value.validate),
            existing.name,
          );
        if (existing.name !== valid.value.name) {
          for (const table of ['watches', 'runs', 'project_repositories', 'agent_assignments']) {
            this.db
              .prepare(`UPDATE ${table} SET repository = ? WHERE repository = ? COLLATE NOCASE`)
              .run(valid.value.name, existing.name);
          }
        }
      })();
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        return invalid('name', 'Repository references cannot be renamed without conflicts');
      }
      throw error;
    }
    return ok(valid.value);
  }

  delete(name: string): Result<void> {
    const existing = this.get(name);
    if (existing === null) return err({ code: 'NOT_FOUND' });
    let hasWatch = false;
    this.db.transaction(() => {
      hasWatch =
        this.db.prepare('SELECT 1 FROM watches WHERE repository = ? COLLATE NOCASE LIMIT 1').get(name) !== undefined;
      if (hasWatch) return;
      this.db.prepare('DELETE FROM project_repositories WHERE repository = ? COLLATE NOCASE').run(existing.name);
      this.db.prepare('DELETE FROM agent_assignments WHERE repository = ? COLLATE NOCASE').run(existing.name);
      this.db.prepare('DELETE FROM repositories WHERE name = ?').run(existing.name);
    })();
    if (hasWatch) return invalid('name', 'Repository is referenced by Watches');
    return ok(undefined);
  }

  private validate(input: RepositoryInput): Result<Repository> {
    if (typeof input.name !== 'string' || input.name.trim() === '') return invalid('name', 'Name is required');
    if (typeof input.folder !== 'string' || input.folder.trim() === '') return invalid('folder', 'Folder is required');
    if (!Array.isArray(input.validate) || input.validate.some((command) => typeof command !== 'string')) {
      return invalid('validate', 'Validation commands must be strings');
    }
    const repository: Repository = {
      name: input.name.trim(),
      folder: resolvePath(input.folder, this.config.configDir),
      gitlab: input.gitlab || null,
      github: input.github || null,
      jira: input.jira || null,
      validate: [...input.validate],
    };
    if (repository.gitlab === null && repository.github === null) {
      return invalid('gitlab', 'A repository needs a GitLab or GitHub connection');
    }
    if (repository.gitlab !== null && !Object.hasOwn(this.config.gitlab, repository.gitlab)) {
      return invalid('gitlab', `Unknown GitLab connection "${repository.gitlab}"`);
    }
    if (repository.github !== null && !Object.hasOwn(this.config.github, repository.github)) {
      return invalid('github', `Unknown GitHub connection "${repository.github}"`);
    }
    if (repository.jira !== null && !Object.hasOwn(this.config.jira.connections, repository.jira)) {
      return invalid('jira', `Unknown Jira connection "${repository.jira}"`);
    }
    try {
      if (!fs.statSync(repository.folder).isDirectory()) return invalid('folder', 'Folder must be a directory');
    } catch {
      return invalid('folder', 'Folder does not exist');
    }
    return ok(repository);
  }

  private fromRow(row: RepositoryRow): Repository {
    const { validate_json, ...repository } = row;
    return { ...repository, validate: JSON.parse(validate_json) as string[] };
  }
}
