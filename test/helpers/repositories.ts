import type { Config } from '../../src/core/config/schema';
import type { Database } from '../../src/core/db/open';
import { RepositoryService, type RepositoryReader } from '../../src/core/repositories/repositoryService';

export function testRepositories(db: Database, config: Config): RepositoryService {
  const repositories = new RepositoryService(db, config);
  for (const [name, repository] of Object.entries(config.repositories)) {
    const result = repositories.create({
      name,
      folder: repository.folder,
      gitlab: repository.gitlab ?? null,
      github: repository.github ?? null,
      jira: repository.jira ?? null,
      validate: repository.validate,
    });
    if (!result.ok) throw new Error(`Could not create test Repository "${name}": ${JSON.stringify(result.error)}`);
  }

  return repositories;
}

export function testRepositoryReader(config: Config): RepositoryReader {
  return {
    get(name) {
      const repository = config.repositories[name];
      return repository === undefined
        ? null
        : {
            name,
            folder: repository.folder,
            gitlab: repository.gitlab ?? null,
            github: repository.github ?? null,
            jira: repository.jira ?? null,
            validate: repository.validate,
            promptAddition: '',
          };
    },
  };
}
