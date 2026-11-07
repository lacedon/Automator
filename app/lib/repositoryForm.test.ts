import { describe, expect, test } from 'vitest';
import { repositoryFromForm } from './repositoryForm';

describe('repositoryFromForm', () => {
  test('maps fields, nulls blank connections, and normalizes validation commands', () => {
    const data = new FormData();
    data.set('name', 'pages');
    data.set('folder', '/repo');
    data.set('gitlab', 'corp');
    data.set('github', '');
    data.set('validate', ' npm test \r\n\r\n  npm run check\n');
    expect(repositoryFromForm(data)).toEqual({
      name: 'pages',
      folder: '/repo',
      gitlab: 'corp',
      github: null,
      jira: null,
      validate: ['npm test', 'npm run check'],
    });
  });
});
