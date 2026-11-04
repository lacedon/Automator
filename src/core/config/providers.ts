import type { ProviderName } from '../domain/types';
import type { Config } from './schema';

export type ProviderOptions = { bin: string; defaultModel: string; models: string[] };

export function providerOptions(config: Config, provider: ProviderName): ProviderOptions {
  if (provider === 'copilot') {
    return {
      bin: config.copilotBin,
      defaultModel: config.runs.defaultModel,
      models: config.runs.models,
    };
  }
  return config.providers[provider];
}
