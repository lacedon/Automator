import { copilotAuthEnvNames, resolveSecrets } from '@core/index';
import { getCore } from './core';

// Only variables the application reads as credentials can be stored, so a user cannot override e.g. PATH.
export function credentialNames(): string[] {
  const { config } = getCore();
  return [...new Set([...copilotAuthEnvNames, ...resolveSecrets(config, {}).envNames])].sort();
}
