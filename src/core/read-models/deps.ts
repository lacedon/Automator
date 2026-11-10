import type { ConfigFor } from '../config/resolver';
import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { Clock } from '../domain/types';
import type { DataDir } from '../files/dataDir';
import type { RepositoryService } from '../repositories/repositoryService';

export interface ReadDeps {
  db: Database;
  config: Config;
  configFor?: ConfigFor;
  clock: Clock;
  dataDir: DataDir;
  repositories: RepositoryService;
}

// Settings in effect for a Repository: its Project's overrides over the global config.
export function configOf(deps: ReadDeps, repository: string | null): Config {
  return deps.configFor?.(repository) ?? deps.config;
}
