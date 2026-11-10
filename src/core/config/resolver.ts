import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';
import { resolveSecrets, type Env, type Secrets } from './load';
import {
  applyOverrides,
  describeOverrides,
  unknownOverrideIds,
  type OverrideRow,
  type OverrideValues,
} from './overrides';
import type { Config } from './schema';

// Effective settings of the Project a Repository belongs to; null means "no Repository" and yields the global config.
export type ConfigFor = (repository: string | null) => Config;

type Row = Record<string, unknown>;

function parseValues(json: unknown): OverrideValues {
  try {
    const value: unknown = JSON.parse(typeof json === 'string' ? json : '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as OverrideValues) : {};
  } catch {
    return {};
  }
}

// Effective settings are computed on every use, so global changes and Project assignment changes apply to the next
// piece of work without anything being copied into Runs or Repositories.
export class ConfigResolver {
  constructor(
    private readonly db: Database,
    readonly base: Config,
    private readonly env: Env = process.env,
  ) {}

  valuesOf(projectId: number): OverrideValues | null {
    const row = this.db.prepare('SELECT config_overrides FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    return row === undefined ? null : parseValues(row.config_overrides);
  }

  describe(projectId: number): OverrideRow[] | null {
    const values = this.valuesOf(projectId);
    return values === null ? null : describeOverrides(this.base, values);
  }

  forProject(projectId: number | null): Config {
    if (projectId === null) return this.base;
    return this.resolve(projectId, this.valuesOf(projectId) ?? {});
  }

  forRepository(repository: string | null): Config {
    if (repository === null) return this.base;
    const row = this.db
      .prepare(
        `SELECT p.id, p.config_overrides FROM project_repositories pr JOIN projects p ON p.id = pr.project_id
         WHERE pr.repository = ? COLLATE NOCASE`,
      )
      .get(repository) as Row | undefined;
    return row === undefined ? this.base : this.resolve(row.id as number, parseValues(row.config_overrides));
  }

  all(): Config[] {
    const rows = this.db.prepare('SELECT id FROM projects').all() as Row[];
    return [this.base, ...rows.map((row) => this.forProject(row.id as number))];
  }

  setValues(projectId: number, values: OverrideValues): Result<OverrideValues> {
    if (this.valuesOf(projectId) === null) return err({ code: 'NOT_FOUND' });
    const unknown = unknownOverrideIds(this.base, values)[0];
    if (unknown !== undefined) {
      return err({ code: 'INVALID_INPUT', field: unknown, message: 'Unknown setting' });
    }
    const applied = applyOverrides(this.base, values);
    if (!applied.ok) {
      const entries = Object.entries(applied.errors);
      const [field] = entries[0]!;
      return err({
        code: 'INVALID_INPUT',
        field,
        message: entries.map(([id, message]) => `${id}: ${message}`).join('; '),
      });
    }
    this.db
      .prepare('UPDATE projects SET config_overrides = ? WHERE id = ?')
      .run(JSON.stringify(applied.values), projectId);
    return ok(applied.values);
  }

  // Secrets are read from the environment by the variable names of the given effective config. The names of every
  // Project are reported so that a child process never inherits any Project's credentials.
  secretsFor(config: Config): Secrets {
    const secrets = resolveSecrets(config, this.env);
    const names = new Set(secrets.envNames);
    for (const name of resolveSecrets(this.base, this.env).envNames) names.add(name);
    const rows = this.db.prepare('SELECT id, config_overrides FROM projects').all() as Row[];
    for (const row of rows) {
      for (const name of resolveSecrets(this.resolve(row.id as number, parseValues(row.config_overrides)), this.env)
        .envNames) {
        names.add(name);
      }
    }
    return { ...secrets, envNames: [...names] };
  }

  private resolve(projectId: number, values: OverrideValues): Config {
    const applied = applyOverrides(this.base, values);
    if (applied.ok) return applied.config;
    // A later global change can invalidate a stored override; the Project then falls back to the global settings.
    console.error(
      `${new Date().toISOString()} config: Project #${projectId} overrides are invalid and ignored: ${Object.values(applied.errors).join('; ')}`,
    );
    return this.base;
  }
}
