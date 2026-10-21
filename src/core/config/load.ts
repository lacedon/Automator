import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createConfigSchema, findReferenceIssues, type Config } from './schema';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Secrets = {
  gitlab: Record<string, string | undefined>;
  jira: Record<string, { email?: string; token?: string }>;
  envNames: string[];
};

export function loadConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const env = opts.env ?? process.env;
  const file = path.resolve(opts.path ?? env.AUTOMATOR_CONFIG ?? path.join(process.cwd(), 'automator.config.json'));
  const configDir = path.dirname(file);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Cannot read config ${file}: ${(e as Error).message}`);
  }

  const parsed = createConfigSchema(configDir).safeParse(raw);
  const issues = [...(parsed.success ? [] : parsed.error.issues), ...findReferenceIssues(raw)];
  if (!parsed.success || issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid config ${file}:\n${lines.join('\n')}`);
  }
  return { ...parsed.data, configDir };
}

export function resolveSecrets(config: Config, env: NodeJS.ProcessEnv): Secrets {
  const envNames = new Set<string>();
  const gitlab: Secrets['gitlab'] = {};
  for (const [name, conn] of Object.entries(config.gitlab)) {
    envNames.add(conn.tokenEnv);
    gitlab[name] = env[conn.tokenEnv];
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
  return { gitlab, jira, envNames: [...envNames] };
}

export function loadDotenv(configDir: string): void {
  const file = path.join(configDir, '.env');
  if (fs.existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
}
