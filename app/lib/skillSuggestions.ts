import type { Skill } from '@core/index';
import type { Suggestion } from '../components/PromptInput';

// Skills are offered as `/name `.
export function skillSuggestions(skills: Skill[], hints: { global: string; local: string }): Suggestion[] {
  return skills.map((skill) => ({
    id: `skill:${skill.name}`,
    label: `/${skill.name}`,
    hint: skill.scope === 'local' ? hints.local : hints.global,
    insert: `/${skill.name} `,
  }));
}

// A skill wins over a built-in command with the same name (`/model a` is the `model` command).
export function isShadowed(command: Suggestion, skills: Skill[]): boolean {
  const name = command.label.split(' ')[0]!;
  return skills.some((skill) => `/${skill.name}` === name);
}

export function withSkills(
  builtIns: Suggestion[],
  skills: Skill[],
  hints: { global: string; local: string },
): Suggestion[] {
  return [...builtIns.filter((c) => !isShadowed(c, skills)), ...skillSuggestions(skills, hints)];
}
