import type { ProviderName } from '../domain/types';

export type InteractiveCapabilities = {
  interactive: boolean; // gates Interactive mode (all false until the session runtime ships)
  protocol: 'acp' | 'pi-rpc';
  resume: boolean; // provider session can be reloaded by id
  automatorTools: 'mcp' | 'pi-extension' | 'none';
  nativeQuestions: 'acp-elicitation' | 'pi-extension-ui' | 'none';
  nativeTimers: boolean; // unprompted turns may occur
  reason: string | null; // tooltip text when interactive is false
};

const NOT_YET = 'Interactive mode is not available for this provider yet';

export const INTERACTIVE_CAPABILITIES: Record<ProviderName, InteractiveCapabilities> = {
  copilot: {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: NOT_YET,
  },
  'claude-code': {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: NOT_YET,
  },
  codex: {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: NOT_YET,
  },
  opencode: {
    interactive: false,
    protocol: 'acp',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: NOT_YET,
  },
  pi: {
    interactive: false,
    protocol: 'pi-rpc',
    resume: false,
    automatorTools: 'none',
    nativeQuestions: 'none',
    nativeTimers: false,
    reason: NOT_YET,
  },
};

export function interactiveSupport(provider: ProviderName): { supported: boolean; reason: string | null } {
  const capabilities = INTERACTIVE_CAPABILITIES[provider];
  return {
    supported: capabilities.interactive,
    reason: capabilities.interactive ? null : (capabilities.reason ?? NOT_YET),
  };
}
