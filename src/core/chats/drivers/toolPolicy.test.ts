import { describe, expect, test } from 'vitest';
import type { ToolPolicy } from './sessionDriver';
import { copilotToolArgs, permissionDecision, piToolArgs, unsupportedPolicy } from './toolPolicy';

const open: ToolPolicy = { allowAll: true, allowed: [], blocked: [], denyTools: [] };

describe('permissionDecision', () => {
  test('allowAll answers permission requests with allow', () => {
    for (const provider of ['copilot', 'claude-code', 'codex', 'opencode'] as const) {
      expect(permissionDecision(provider, open, { tool: 'Bash', kind: 'execute' })).toBe('allow');
    }
  });

  test('blocked and denied tools are refused even under allowAll', () => {
    const policy: ToolPolicy = { ...open, blocked: ['shell(rm)'], denyTools: ['write'] };
    expect(permissionDecision('copilot', policy, { tool: 'shell(rm)' })).toBe('deny');
    expect(permissionDecision('copilot', policy, { tool: 'write' })).toBe('deny');
    expect(permissionDecision('copilot', policy, { tool: 'view' })).toBe('allow');
  });

  test('without allowAll only allowed tools pass, matched by name or kind', () => {
    const policy: ToolPolicy = { allowAll: false, allowed: ['view', 'execute'], blocked: [], denyTools: [] };
    expect(permissionDecision('copilot', policy, { tool: 'view' })).toBe('allow');
    expect(permissionDecision('copilot', policy, { tool: 'Bash', kind: 'execute' })).toBe('allow');
    expect(permissionDecision('copilot', policy, { tool: 'write', kind: 'edit' })).toBe('deny');
  });

  test('Automator MCP tools are always allowed unless explicitly blocked', () => {
    const closed: ToolPolicy = { allowAll: false, allowed: [], blocked: [], denyTools: [] };
    expect(permissionDecision('claude-code', closed, { tool: 'mcp__automator__ask_user', kind: 'other' })).toBe(
      'allow',
    );
    expect(
      permissionDecision(
        'claude-code',
        { ...closed, blocked: ['mcp__automator__ask_user'] },
        { tool: 'mcp__automator__ask_user' },
      ),
    ).toBe('deny');
  });
});

describe('start flags', () => {
  test('Copilot policy is passed as start flags identical to copilotLauncher', () => {
    expect(copilotToolArgs(open)).toEqual(['--allow-all-tools']);
    expect(
      copilotToolArgs({
        allowAll: false,
        allowed: ['view', 'shell(git:*)'],
        blocked: ['shell(rm)'],
        denyTools: ['write'],
      }),
    ).toEqual([
      '--allow-tool',
      'write',
      '--allow-tool',
      'view',
      '--allow-tool',
      'shell(git:*)',
      '--deny-tool',
      'write',
      '--deny-tool',
      'shell(rm)',
    ]);
    expect(copilotToolArgs({ ...open, denyTools: ['shell(curl)'] })).toEqual([
      '--allow-all-tools',
      '--deny-tool',
      'shell(curl)',
    ]);
  });

  test('pi maps denyTools to --exclude-tools', () => {
    expect(piToolArgs(open)).toEqual([]);
    expect(piToolArgs({ ...open, denyTools: ['bash', 'write'] })).toEqual(['--exclude-tools', 'bash,write']);
  });
});

describe('unsupportedPolicy', () => {
  test('non-Copilot providers reject denyTools and custom Agent tools like their launchers', () => {
    expect(unsupportedPolicy('claude-code', { ...open, denyTools: ['x'] })).toEqual({
      code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
      message: 'Claude Code cannot enforce runs.denyTools; clear the setting before using this provider.',
    });
    expect(unsupportedPolicy('codex', { ...open, denyTools: ['x'] })?.message).toContain('Codex cannot enforce');
    expect(unsupportedPolicy('opencode', { ...open, denyTools: ['x'] })?.message).toContain('OpenCode cannot enforce');
    for (const provider of ['claude-code', 'codex', 'opencode', 'pi'] as const) {
      expect(unsupportedPolicy(provider, { ...open, allowAll: false })).toMatchObject({
        code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
        message: expect.stringContaining('only the Copilot provider enforces'),
      });
      expect(unsupportedPolicy(provider, { ...open, blocked: ['x'] })?.code).toBe('PROVIDER_CAPABILITY_UNSUPPORTED');
    }
    expect(unsupportedPolicy('claude-code', open)).toBeNull();
  });

  test('Copilot enforces everything and pi accepts denyTools', () => {
    expect(
      unsupportedPolicy('copilot', { allowAll: false, allowed: ['a'], blocked: ['b'], denyTools: ['c'] }),
    ).toBeNull();
    expect(unsupportedPolicy('pi', { ...open, denyTools: ['bash'] })).toBeNull();
  });
});
