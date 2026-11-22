import type { ProviderName, RunError } from '../../domain/types';
import type { ToolPolicy } from './sessionDriver';

// Interactive mode keeps exactly the one-shot launchers' rules (plan clarification 12): Copilot-pattern tool
// settings are enforced only by Copilot, pi maps runs.denyTools to --exclude-tools, everything else rejects them.

const AUTOMATOR_MCP_PREFIX = 'mcp__automator__';
const providerNames: Record<ProviderName, string> = {
  copilot: 'Copilot',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'pi',
};

export function hasCustomTools(policy: ToolPolicy): boolean {
  return !policy.allowAll || policy.allowed.length > 0 || policy.blocked.length > 0;
}

const matches = (pattern: string, request: { tool: string; kind?: string }): boolean =>
  pattern === request.tool ||
  (request.kind !== undefined && pattern === request.kind) ||
  request.tool.startsWith(`${pattern}(`) ||
  (pattern.endsWith('*') && request.tool.startsWith(pattern.slice(0, -1)));

// Answers a provider permission request by policy. The user is never asked.
export function permissionDecision(
  _provider: ProviderName,
  policy: ToolPolicy,
  request: { tool: string; kind?: string },
): 'allow' | 'deny' {
  if ([...policy.denyTools, ...policy.blocked].some((pattern) => matches(pattern, request))) return 'deny';
  if (request.tool.startsWith(AUTOMATOR_MCP_PREFIX)) return 'allow';
  if (policy.allowAll) return 'allow';
  return policy.allowed.some((pattern) => matches(pattern, request)) ? 'allow' : 'deny';
}

export function unsupportedPolicy(provider: ProviderName, policy: ToolPolicy): RunError | null {
  if (provider === 'copilot') return null;
  if (provider !== 'pi' && policy.denyTools.length > 0) {
    return {
      code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
      message: `${providerNames[provider]} cannot enforce runs.denyTools; clear the setting before using this provider.`,
    };
  }
  if (hasCustomTools(policy)) {
    return {
      code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
      message: 'The Agent configures tool permissions, which only the Copilot provider enforces.',
    };
  }
  return null;
}

// Copilot fixes tool filtering when the ACP server starts; these are the flags copilotLauncher passes.
export function copilotToolArgs(policy: ToolPolicy): string[] {
  return [
    ...(policy.allowAll ? ['--allow-all-tools'] : ['--allow-tool', 'write']),
    ...policy.allowed.flatMap((pattern) => ['--allow-tool', pattern]),
    ...[...policy.denyTools, ...policy.blocked].flatMap((pattern) => ['--deny-tool', pattern]),
  ];
}

export function piToolArgs(policy: ToolPolicy): string[] {
  return policy.denyTools.length > 0 ? ['--exclude-tools', policy.denyTools.join(',')] : [];
}
