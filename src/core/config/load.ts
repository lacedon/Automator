import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { writeJsonAtomic } from '../files/atomic';
import { migrateLegacyConfig } from './migrate';
import { createConfigSchema, type Config } from './schema';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Plain record instead of NodeJS.ProcessEnv: Next's global types make NODE_ENV a required ProcessEnv key.
export type Env = Record<string, string | undefined>;

export type Secrets = {
  gitlab: Record<string, string | undefined>;
  github: Record<string, string | undefined>;
  jira: Record<string, { email?: string; token?: string }>;
  envNames: string[];
};

export function readRawConfig(configPath: string): unknown {
  const file = path.resolve(configPath);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Cannot read config ${file}: ${(e as Error).message}`);
  }
}

export function loadConfig(opts: { path?: string; env?: Env } = {}): Config {
  const env = opts.env ?? process.env;
  const file = path.resolve(opts.path ?? env.AUTOMATOR_CONFIG ?? path.join(process.cwd(), 'automator.config.json'));
  const configDir = path.dirname(file);

  const migration = migrateLegacyConfig(readRawConfig(file));
  const raw = migration.raw;
  const parsed = createConfigSchema(configDir).safeParse(raw);
  const issues = parsed.success ? [] : parsed.error.issues;
  if (!parsed.success || issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid config ${file}:\n${lines.join('\n')}`);
  }
  if (migration.changed) saveMigratedConfig(file, raw);
  return { ...parsed.data, configDir } as Config;
}

// The migrated config is persisted so the legacy keys disappear from the file; a read-only file keeps working in memory.
function saveMigratedConfig(file: string, raw: unknown): void {
  try {
    writeJsonAtomic(file, raw);
  } catch (e) {
    console.error(`config: could not save the migrated config ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Returns a function that yields a freshly loaded Config when the file changed since the last call and is valid;
// an invalid edit keeps the last valid config in effect and is logged.
export function configReloader(file: string, env: Env = process.env): () => Config | null {
  const stamp = () => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  };
  let seen = stamp();
  return () => {
    const now = stamp();
    if (now === null || now === seen) return null;
    seen = now;
    try {
      return loadConfig({ path: file, env });
    } catch (e) {
      console.error(
        `${new Date().toISOString()} config: reload failed, keeping previous config: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  };
}

export function resolveSecrets(config: Config, env: Env): Secrets {
  const envNames = new Set<string>();
  const gitlab: Secrets['gitlab'] = {};
  for (const [name, conn] of Object.entries(config.gitlab)) {
    envNames.add(conn.tokenEnv);
    gitlab[name] = env[conn.tokenEnv];
  }
  const github: Secrets['github'] = {};
  for (const [name, conn] of Object.entries(config.github)) {
    envNames.add(conn.tokenEnv);
    github[name] = env[conn.tokenEnv];
  }
  const jira: Secrets['jira'] = {};
  for (const [name, conn] of Object.entries(config.jira.connections)) {
    if (conn.emailEnv) envNames.add(conn.emailEnv);
    if (conn.tokenEnv) envNames.add(conn.tokenEnv);
    jira[name] = {
      email: conn.emailEnv ? env[conn.emailEnv] : undefined,
      token: conn.tokenEnv ? env[conn.tokenEnv] : undefined,
    };
  }
  return { gitlab, github, jira, envNames: [...envNames] };
}

export function loadDotenv(configDir: string): void {
  const file = path.join(configDir, '.env');
  if (fs.existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
}
