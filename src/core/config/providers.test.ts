import { describe, expect, test } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import { providerOptions } from './providers';

describe('providerOptions', () => {
  test('returns only the selected provider executable and models', () => {
    const config = testConfig();
    Object.assign(config, {
      providers: {
        'claude-code': { bin: 'claude', defaultModel: '', models: [] },
        codex: { bin: '/opt/codex', defaultModel: 'codex-model', models: ['codex-fast'] },
        opencode: { bin: 'opencode', defaultModel: '', models: [] },
      },
    });

    expect(providerOptions(config, 'codex')).toEqual({
      bin: '/opt/codex',
      defaultModel: 'codex-model',
      models: ['codex-fast'],
    });
  });
});
