import { expect, test } from 'vitest';
import { suggestionsFor, type Suggestion } from '../components/PromptInput';
import { withSkills } from './skillSuggestions';

const hints = { global: 'Global skill', local: 'Local skill' };
const builtIns: Suggestion[] = [
  { id: 'ticket', label: '/ticket' },
  { id: 'model:a', label: '/model a' },
  { id: 'model:b', label: '/model b' },
];

test('lists skills with scope hints alongside the built-in commands', () => {
  const list = withSkills(
    builtIns,
    [
      { name: 'review', scope: 'local' },
      { name: 'deploy', scope: 'global' },
    ],
    hints,
  );
  expect(list.map((s) => s.label)).toEqual(['/ticket', '/model a', '/model b', '/review', '/deploy']);
  expect(list.find((s) => s.label === '/review')).toMatchObject({ hint: 'Local skill', insert: '/review ' });
  expect(list.find((s) => s.label === '/deploy')).toMatchObject({ hint: 'Global skill' });
});

test('a skill wins over a built-in command with the same name', () => {
  const list = withSkills(builtIns, [{ name: 'model', scope: 'global' }], hints);
  expect(list.map((s) => s.label)).toEqual(['/ticket', '/model']);
});

test('run chat: typing / at the start of a line opens skills, filtered as the user types', () => {
  const commands = withSkills(
    [],
    [
      { name: 'review', scope: 'global' },
      { name: 'deploy', scope: 'local' },
    ],
    hints,
  );
  expect(suggestionsFor('/', 1, commands, []).map((s) => s.label)).toEqual(['/review', '/deploy']);
  expect(suggestionsFor('/rev', 4, commands, []).map((s) => s.label)).toEqual(['/review']);
  expect(suggestionsFor('hi\n/dep', 7, commands, []).map((s) => s.label)).toEqual(['/deploy']);
  expect(suggestionsFor('hi /dep', 7, commands, [])).toEqual([]);
});

test('new chat: skills for the selected repository come with the built-ins', () => {
  const bySettings = {
    one: [{ name: 'a', scope: 'local' as const }],
    two: [{ name: 'b', scope: 'global' as const }],
  };
  const labels = (repo: 'one' | 'two') =>
    suggestionsFor('/', 1, withSkills(builtIns, bySettings[repo], hints), []).map((s) => s.label);
  expect(labels('one')).toContain('/a');
  expect(labels('one')).toContain('/ticket');
  expect(labels('two')).toContain('/b');
  expect(labels('two')).not.toContain('/a');
});
