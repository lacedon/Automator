import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { Clock } from '../domain/types';
import type { DataDir } from '../files/dataDir';
import type { RepositoryService } from '../repositories/repositoryService';

export interface ReadDeps {
  db: Database;
  config: Config;
  clock: Clock;
  dataDir: DataDir;
  repositories: RepositoryService;
}
