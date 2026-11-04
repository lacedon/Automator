import type { ProviderName } from '@core/index';

const providerLabels: Record<ProviderName, string> = {
  copilot: 'GitHub Copilot CLI',
  'claude-code': 'Claude Code',
  codex: 'OpenAI Codex CLI',
  opencode: 'OpenCode',
};

export function providerLabel(provider: ProviderName): string {
  return providerLabels[provider];
}
