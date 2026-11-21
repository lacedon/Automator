import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from './skills';

let root: string;
let home: string;
let repo: string;

function skill(base: string, folder: string, name: string) {
  const dir = path.join(base, folder, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# skill');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('discoverSkills', () => {
  it('returns nothing for missing folders', () => {
    expect(discoverSkills({ provider: 'claude-code', repositoryFolder: repo, homeDir: home })).toEqual([]);
    expect(discoverSkills({ provider: 'claude-code', repositoryFolder: null, homeDir: home })).toEqual([]);
  });

  it('reads global and local Claude skills and ignores folders without SKILL.md', () => {
    skill(home, '.claude/skills', 'a');
    skill(home, '.agents/skills', 'b');
    skill(repo, '.claude/skills', 'c');
    fs.mkdirSync(path.join(home, '.claude/skills/empty'));
    expect(discoverSkills({ provider: 'claude-code', repositoryFolder: repo, homeDir: home })).toEqual([
      { name: 'a', scope: 'global' },
      { name: 'b', scope: 'global' },
      { name: 'c', scope: 'local' },
    ]);
  });

  it('lets local override global and specific global folders override ~/.agents/skills', () => {
    skill(home, '.agents/skills', 'x');
    skill(home, '.claude/skills', 'x');
    skill(home, '.agents/skills', 'y');
    skill(repo, '.claude/skills', 'y');
    const result = discoverSkills({ provider: 'claude-code', repositoryFolder: repo, homeDir: home });
    expect(result).toEqual([
      { name: 'x', scope: 'global' },
      { name: 'y', scope: 'local' },
    ]);
  });

  it("uses each provider's own folders", () => {
    skill(home, '.codex/skills', 'codex-only');
    skill(home, '.config/opencode/skills', 'oc-only');
    skill(home, '.copilot/skills', 'cp-only');
    skill(repo, '.agents/skills', 'local-codex');
    skill(repo, '.opencode/skills', 'local-oc');
    skill(home, '.pi/agent/skills', 'pi-only');
    skill(repo, '.pi/skills', 'local-pi');
    const names = (provider: Parameters<typeof discoverSkills>[0]['provider']) =>
      discoverSkills({ provider, repositoryFolder: repo, homeDir: home }).map((s) => s.name);
    expect(names('codex')).toEqual(['codex-only', 'local-codex']);
    expect(names('opencode')).toEqual(['local-oc', 'oc-only']);
    expect(names('pi')).toEqual(['local-pi', 'pi-only']);
    expect(names('copilot')).toEqual(['cp-only']);
  });
});
