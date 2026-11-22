import type { ProviderName } from '../domain/types';
import type { Config } from './schema';

export type ProviderOptions = { bin: string; acpBin?: string; defaultModel: string; models: string[] };

export function providerOptions(config: Config, provider: ProviderName): ProviderOptions {
  return config.providers[provider];
}
