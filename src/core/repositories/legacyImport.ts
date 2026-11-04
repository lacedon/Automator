import type { Database } from '../db/open';
import { resolvePath } from '../config/schema';

export const LEGACY_REPOSITORIES_MARKER = 'legacy_repositories_imported';

type LegacyRepository = {
  folder: string;
  gitlab: string | null;
  github: string | null;
  jira: string | null;
  validate: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRepositories(raw: unknown, configDir: string): [string, LegacyRepository][] | null {
  if (!isRecord(raw) || !Object.hasOwn(raw, 'repositories')) return null;
  const legacy = raw.repositories;
  if (!isRecord(legacy)) throw new Error('Legacy repositories must be an object');
  return Object.entries(legacy).map(([name, value]) => {
    if (!name.trim() || !isRecord(value) || typeof value.folder !== 'string' || value.folder.trim() === '') {
      throw new Error(`Invalid legacy repository "${name}"`);
    }
    const connection = (field: 'gitlab' | 'github' | 'jira'): string | null => {
      const item = value[field];
      if (item === undefined) return null;
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`Invalid legacy repository "${name}" field "${field}"`);
      }
      return item;
    };
    const gitlab = connection('gitlab');
    const github = connection('github');
    const jira = connection('jira');
    if (gitlab === null && github === null) {
      throw new Error(`Invalid legacy repository "${name}": a GitLab or GitHub connection is required`);
    }
    const validate = value.validate ?? [];
    if (!Array.isArray(validate) || validate.some((command) => typeof command !== 'string')) {
      throw new Error(`Invalid legacy repository "${name}" field "validate"`);
    }
    return [
      name,
      { folder: resolvePath(value.folder, configDir), gitlab, github, jira, validate: [...validate] as string[] },
    ];
  });
}

export function importLegacyRepositories(
  db: Database,
  rawConfig: unknown,
  configDir: string,
  log: (message: string) => void = (message) => console.info(message),
): void {
  const importedNames: { value: string[] | null } = { value: null };
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_REPOSITORIES_MARKER) !== undefined) return;
    if ((db.prepare('SELECT COUNT(*) AS count FROM repositories').get() as { count: number }).count !== 0) return;

    const repositories = parseRepositories(rawConfig, configDir);
    if (repositories === null) return;
    const insert = db.prepare(
      `INSERT INTO repositories (name, folder, gitlab, github, jira, validate_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [name, repository] of repositories) {
      insert.run(
        name,
        repository.folder,
        repository.gitlab,
        repository.github,
        repository.jira,
        JSON.stringify(repository.validate),
      );
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(LEGACY_REPOSITORIES_MARKER, '1');
    importedNames.value = repositories.map(([name]) => name);
  }).immediate();
  if (importedNames.value !== null && importedNames.value.length > 0) {
    log(`Imported legacy repositories: ${importedNames.value.join(', ')}`);
  }
}
