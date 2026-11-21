import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderName } from '../domain/types';

export type SkillScope = 'global' | 'local';
export type Skill = { name: string; scope: SkillScope };

// Folders in override order: the first folder wins on a name clash.
const GLOBAL_FOLDERS: Record<ProviderName, string[]> = {
  'claude-code': ['.claude/skills', '.agents/skills'],
  copilot: ['.copilot/skills', '.claude/skills', '.agents/skills'],
  codex: ['.codex/skills', '.agents/skills'],
  opencode: ['.config/opencode/skills', '.claude/skills', '.agents/skills'],
  pi: ['.pi/agent/skills', '.agents/skills'],
};

const LOCAL_FOLDERS: Record<ProviderName, string> = {
  'claude-code': '.claude/skills',
  copilot: '.github/skills',
  codex: '.agents/skills',
  opencode: '.opencode/skills',
  pi: '.pi/skills',
};

// A skill is a sub-folder (or a link to one) holding a SKILL.md; its name is the folder name.
function skillNames(folder: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    try {
      return fs.statSync(path.join(folder, name, 'SKILL.md')).isFile();
    } catch {
      return false;
    }
  });
}

export function discoverSkills(options: {
  provider: ProviderName;
  repositoryFolder: string | null;
  homeDir?: string;
}): Skill[] {
  const home = options.homeDir ?? os.homedir();
  const found = new Map<string, Skill>();
  const add = (folder: string, scope: SkillScope) => {
    for (const name of skillNames(folder)) if (!found.has(name)) found.set(name, { name, scope });
  };
  if (options.repositoryFolder !== null) {
    add(path.join(options.repositoryFolder, LOCAL_FOLDERS[options.provider]), 'local');
  }
  for (const folder of GLOBAL_FOLDERS[options.provider]) add(path.join(home, folder), 'global');
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
