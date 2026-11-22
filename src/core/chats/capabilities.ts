import type { ProviderName } from '../domain/types';

export type InteractiveCapabilities = {
  interactive: boolean; // gates Interactive mode; the copilot/codex/opencode drivers exist but stay gated until resume is verified
  protocol: 'acp' | 'pi-rpc';
  resume: boolean; // provider session can be reloaded by id
  automatorTools: 'mcp' | 'pi-extension' | 'none';
  nativeQuestions: 'acp-elicitation' | 'pi-extension-ui' | 'none';
  nativeTimers: boolean; // unprompted turns may occur
  reason: string | null; // tooltip text when interactive is false
};

export const INTERACTIVE_CAPABILITIES: Record<ProviderName, InteractiveCapabilities> = {
  copilot: {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: 'Interactive mode is not available for Copilot yet: its ACP session resume is not verified',
  },
  'claude-code': {
    interactive: true,
    protocol: 'acp',
    resume: true,
    automatorTools: 'mcp',
    nativeQuestions: 'acp-elicitation',
    nativeTimers: true,
    reason: null,
  },
  codex: {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: 'Interactive mode is not available for Codex yet: its ACP session resume is not verified',
  },
  opencode: {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: 'Interactive mode is not available for OpenCode yet: its ACP session resume is not verified',
  },
  pi: {
    interactive: true,
    protocol: 'pi-rpc',
    resume: true,
    automatorTools: 'pi-extension',
    nativeQuestions: 'pi-extension-ui',
    nativeTimers: false,
    reason: null,
  },
};

export function interactiveSupport(provider: ProviderName): { supported: boolean; reason: string | null } {
  const capabilities = INTERACTIVE_CAPABILITIES[provider];
  return {
    supported: capabilities.interactive,
    reason: capabilities.interactive ? null : capabilities.reason,
  };
}
