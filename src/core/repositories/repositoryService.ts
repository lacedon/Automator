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
  promptAddition: string;
};

export type RepositoryInput = Omit<Repository, 'promptAddition'> & { promptAddition?: string };
export type RepositoryReader = Pick<RepositoryService, 'get'>;

type RepositoryRow = Omit<Repository, 'validate' | 'promptAddition'> & {
  validate_json: string;
  prompt_addition: string;
};
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
    return this.problems(repository).map((problem) => problem.status);
  }

  create(input: RepositoryInput): Result<Repository> {
    const valid = this.validate(input);
    if (!valid.ok) return valid;
    if (this.get(valid.value.name) !== null) return invalid('name', 'Name is already in use');
    this.db
      .prepare(
        `INSERT INTO repositories (name, folder, gitlab, github, jira, validate_json, prompt_addition)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.value.name,
        valid.value.folder,
        valid.value.gitlab,
        valid.value.github,
        valid.value.jira,
        JSON.stringify(valid.value.validate),
        valid.value.promptAddition,
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
            `UPDATE repositories
             SET name = ?, folder = ?, gitlab = ?, github = ?, jira = ?, validate_json = ?, prompt_addition = ?
             WHERE name = ?`,
          )
          .run(
            valid.value.name,
            valid.value.folder,
            valid.value.gitlab,
            valid.value.github,
            valid.value.jira,
            JSON.stringify(valid.value.validate),
            valid.value.promptAddition,
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
      promptAddition: (input.promptAddition ?? '').trim(),
    };
    const problems = this.problems(repository);
    const problem = problems.find(({ field }) => field !== 'folder') ?? problems[0];
    if (problem !== undefined) return invalid(problem.field, problem.reject);
    return ok(repository);
  }

  // Shared checks: `status` reports `status` text for persisted records, `validate` rejects with `reject` text.
  private problems(repository: Repository): { field: string; status: string; reject: string }[] {
    const problems: { field: string; status: string; reject: string }[] = [];
    const add = (field: string, status: string, reject = status) => problems.push({ field, status, reject });
    if (repository.gitlab === null && repository.github === null) {
      add('gitlab', 'A repository needs a GitLab or GitHub connection');
    }
    try {
      if (!fs.statSync(repository.folder).isDirectory()) {
        add('folder', `Folder is not a directory: ${repository.folder}`, 'Folder must be a directory');
      }
    } catch {
      add('folder', `Folder does not exist: ${repository.folder}`, 'Folder does not exist');
    }
    if (repository.gitlab !== null && !Object.hasOwn(this.config.gitlab, repository.gitlab)) {
      add('gitlab', `Unknown GitLab connection "${repository.gitlab}"`);
    }
    if (repository.github !== null && !Object.hasOwn(this.config.github, repository.github)) {
      add('github', `Unknown GitHub connection "${repository.github}"`);
    }
    if (repository.jira !== null && !Object.hasOwn(this.config.jira.connections, repository.jira)) {
      add('jira', `Unknown Jira connection "${repository.jira}"`);
    }
    return problems;
  }

  private fromRow(row: RepositoryRow): Repository {
    const { validate_json, prompt_addition, ...repository } = row;
    return { ...repository, validate: JSON.parse(validate_json) as string[], promptAddition: prompt_addition };
  }
}
