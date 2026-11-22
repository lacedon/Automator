import { PassThrough } from 'node:stream';
import type { Env, Secrets } from '../../config/load';
import { providerOptions } from '../../config/providers';
import type { Config } from '../../config/schema';
import type { ProviderName, RunError } from '../../domain/types';
import { copilotAuthEnvNames } from '../../runs/childProcess';
import type { ProviderExit } from '../../runs/providerLauncher';
import { createJsonRpcPeer, JsonRpcError } from './jsonRpc';
import {
  asRunError,
  DriverError,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type SessionStartOptions,
  type StopTimings,
  type ToolPolicy,
  type TurnStopReason,
} from './sessionDriver';
import { spawnSessionProcess } from './sessionProcess';
import { copilotToolArgs, permissionDecision } from './toolPolicy';

export type AcpProvider = Exclude<ProviderName, 'pi'>;
export type AcpCommand = { bin: string; args: string[]; preserveCopilotAuth?: boolean };

const providerLabels: Record<AcpProvider, string> = {
  copilot: 'Copilot',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

// Hand-written ACP client (newline-delimited JSON-RPC over stdio). Provider differences live here and in acpCommand.
export function acpCommand(
  config: Config,
  provider: AcpProvider,
  start: { model: string; tools: ToolPolicy; secretEnvNames: string[] },
): AcpCommand {
  const options = providerOptions(config, provider);
  switch (provider) {
    case 'copilot':
      return {
        bin: options.bin,
        args: [
          '--acp',
          '--model',
          start.model,
          // Copilot fixes tool filtering at server start (it cannot be set per ACP session).
          ...copilotToolArgs(start.tools),
          ...(start.secretEnvNames.length > 0 ? ['--secret-env-vars', start.secretEnvNames.join(',')] : []),
        ],
        preserveCopilotAuth: true,
      };
    case 'opencode':
      return { bin: options.bin, args: ['acp'] };
    case 'claude-code':
    case 'codex':
      return { bin: options.acpBin ?? options.bin, args: [] };
  }
}

const STOP_REASONS: Record<string, TurnStopReason> = {
  end_turn: 'end_turn',
  cancelled: 'cancelled',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function spawnHint(provider: AcpProvider): string {
  if (provider === 'claude-code') {
    return " Install the adapter (npm i -g @agentclientprotocol/claude-agent-acp) or set providers['claude-code'].acpBin; see README, Interactive Chats > Troubleshooting.";
  }
  if (provider === 'codex') {
    return ' Install the adapter (npm i -g @agentclientprotocol/codex-acp) or set providers.codex.acpBin; see README, Interactive Chats > Troubleshooting.';
  }
  return ' See README, Interactive Chats > Troubleshooting.';
}

export function createAcpDriver(
  provider: AcpProvider,
  baseConfig: Config,
  baseSecrets: Secrets,
  timings: Partial<StopTimings> = {},
): SessionDriver {
  return {
    provider,
    start(options: SessionStartOptions): SessionHandle {
      const config = options.scope?.config ?? baseConfig;
      const secrets = options.scope?.secrets ?? baseSecrets;
      const secretEnvNames = new Set(secrets.envNames);
      if (provider === 'copilot') {
        for (const name of copilotAuthEnvNames) if (options.env[name] !== undefined) secretEnvNames.add(name);
      }
      const command = acpCommand(config, provider, {
        model: options.model,
        tools: options.tools,
        secretEnvNames: [...secretEnvNames],
      });
      return new AcpSession(provider, command, secrets, options, timings);
    },
  };
}

class AcpSession implements SessionHandle {
  readonly pid: number;
  readonly ready: Promise<{ providerSessionId: string }>;
  readonly exited: Promise<ProviderExit>;

  private readonly proc;
  private readonly peer;
  private sessionId: string | null = null;
  // Dropped until the first prompt: session/load replays the history and the adapter prints notices at start.
  private acceptUpdates = false;
  private promptInFlight = false;
  private unpromptedActive = false;
  private cancelRequested = false;
  private turnFinished = true;
  private fatal: RunError | null = null;
  private readonly toolTitles = new Map<string, string>();

  constructor(
    private readonly provider: AcpProvider,
    private readonly command: AcpCommand,
    secrets: Secrets,
    private readonly options: SessionStartOptions,
    timings: Partial<StopTimings>,
  ) {
    const input = new PassThrough();
    this.proc = spawnSessionProcess({
      bin: command.bin,
      args: command.args,
      cwd: options.cwd,
      env: options.env as Env,
      secrets,
      logPath: options.logPath,
      preserveCopilotAuth: command.preserveCopilotAuth,
      onStdout: (chunk) => input.write(chunk),
      timings,
    });
    this.pid = this.proc.child.pid;
    this.peer = createJsonRpcPeer(input, this.proc.child.stdin ?? new PassThrough(), (line) => this.proc.log(line));
    this.exited = this.proc.exited.then((exit) => {
      input.end();
      this.onExit(exit);
      return exit;
    });
    this.install();
    this.ready = this.handshake();
    // A rejected ready must not become an unhandled rejection when the caller only watches events.
    this.ready.catch(() => {});
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    return this.proc.onEvent(listener);
  }

  private install(): void {
    this.peer.onNotification('session/update', (params) => this.onUpdate(params));
    this.peer.onRequest('session/request_permission', (params) => this.onPermission(params));
    // Native questions arrive in PR 4. Until then every elicitation is declined and logged.
    for (const method of ['elicitation/create', 'session/elicitation']) {
      this.peer.onRequest(method, (params) => {
        const message = isRecord(params) ? str(params.message) : undefined;
        this.proc.log(`declined native question (${method}): ${message ?? ''}`);
        return { action: 'cancel' };
      });
    }
  }

  private async handshake(): Promise<{ providerSessionId: string }> {
    try {
      const init = await this.peer.request<Rec>('initialize', {
        protocolVersion: 1,
        // Elicitation is not advertised until PR 4 handles questions.
        clientCapabilities: {},
        clientInfo: { name: 'automator', version: '1' },
      });
      const mcpServers = this.options.mcpServer
        ? [
            {
              name: this.options.mcpServer.name,
              command: this.options.mcpServer.command,
              args: this.options.mcpServer.args,
              env: Object.entries(this.options.mcpServer.env).map(([name, value]) => ({ name, value })),
            },
          ]
        : [];
      let sessionId: string;
      const resumeId = this.options.providerSessionId;
      if (resumeId !== undefined) {
        const capabilities = isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
        if (capabilities.loadSession !== true) {
          throw new DriverError({
            code: 'SESSION_RESUME_FAILED',
            message: `${providerLabels[this.provider]} cannot resume sessions (loadSession is not supported).`,
          });
        }
        try {
          await this.peer.request('session/load', { sessionId: resumeId, cwd: this.options.cwd, mcpServers });
        } catch (error) {
          if (this.peer.closedNow()) throw error;
          const detail =
            error instanceof JsonRpcError ? `${error.message} (code ${error.code})` : asRunError(error).message;
          throw new DriverError({
            code: 'SESSION_RESUME_FAILED',
            message: `${providerLabels[this.provider]} could not resume session ${resumeId}: ${detail}`,
          });
        }
        sessionId = resumeId;
      } else {
        const created = await this.peer.request<Rec>('session/new', { cwd: this.options.cwd, mcpServers });
        const id = str(created.sessionId);
        if (id === undefined) {
          throw new DriverError({ code: 'PROVIDER_ERROR', message: 'The provider did not return a session id.' });
        }
        sessionId = id;
      }
      this.sessionId = sessionId;
      await this.configure(sessionId);
      this.proc.emit({ type: 'session', providerSessionId: sessionId });
      return { providerSessionId: sessionId };
    } catch (error) {
      if (error instanceof DriverError) throw error;
      // The connection closed before the handshake finished: report why the process went away.
      const exit = await this.proc.exited;
      throw new DriverError(this.exitError(exit));
    }
  }

  // Model and permission mode are set on the session; Copilot takes both at server start.
  private async configure(sessionId: string): Promise<void> {
    if (this.provider === 'copilot') return;
    try {
      await this.peer.request('session/set_config_option', { sessionId, configId: 'model', value: this.options.model });
    } catch (error) {
      if (this.peer.closedNow()) throw error;
      throw new DriverError({
        code: 'MODEL_UNSUPPORTED',
        message: `${providerLabels[this.provider]} rejected model "${this.options.model}": ${asRunError(error).message}`,
      });
    }
    // The Claude adapter would otherwise ask for permissions; allowAll maps to its bypass mode (as the one-shot launcher).
    if (this.provider === 'claude-code' && this.options.tools.allowAll) {
      try {
        await this.peer.request('session/set_config_option', {
          sessionId,
          configId: 'mode',
          value: 'bypassPermissions',
        });
      } catch (error) {
        if (this.peer.closedNow()) throw error;
        // Permission requests are still answered by policy, so a refused mode is not fatal.
        this.proc.log(`could not set bypassPermissions: ${asRunError(error).message}`);
      }
    }
  }

  private exitError(exit: ProviderExit): RunError {
    if (exit.error !== undefined) {
      if (exit.error.code === 'SPAWN_FAILED') {
        return {
          code: 'SPAWN_FAILED',
          message: `Cannot start "${this.command.bin}": ${exit.error.message}.${spawnHint(this.provider)}`,
        };
      }
      return exit.error;
    }
    const how = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${exit.code}`;
    return { code: 'PROVIDER_ERROR', message: `${providerLabels[this.provider]} exited with ${how}.` };
  }

  private onExit(exit: ProviderExit): void {
    const error = this.exitError(exit);
    this.fatal = error;
    if (this.promptInFlight) {
      this.finishTurn(this.cancelRequested ? { stopReason: 'cancelled' } : { stopReason: 'error', error });
    }
    this.proc.emit({ type: 'exit', exit: exit.error === undefined ? exit : { ...exit, error } });
  }

  // Updates that arrive while no prompt is in flight are unprompted turns (native timers). Only substantive
  // updates count; usage and bookkeeping notifications are ignored.
  private onUpdate(params: unknown): void {
    if (!this.acceptUpdates || !isRecord(params) || !isRecord(params.update)) return;
    const update = params.update;
    const kind = str(update.sessionUpdate);
    if (kind === 'usage_update') {
      // The adapter closes an unprompted turn with a usage_update that carries the cost.
      if (this.unpromptedActive && !this.promptInFlight && update.cost !== undefined) this.unpromptedActive = false;
      return;
    }
    const substantive = kind === 'agent_message_chunk' || kind === 'tool_call' || kind === 'tool_call_update';
    if (!substantive) return;
    if (!this.promptInFlight && !this.unpromptedActive) {
      this.unpromptedActive = true;
      this.proc.emit({ type: 'turn-start', prompted: false });
    }
    if (kind === 'agent_message_chunk') {
      const content = isRecord(update.content) ? update.content : {};
      const text = str(content.text);
      if (content.type === 'text' && text !== undefined && text !== '') this.proc.emit({ type: 'text', delta: text });
      return;
    }
    const id = str(update.toolCallId);
    if (id === undefined) return;
    const title = str(update.title) ?? this.toolTitles.get(id) ?? str(update.name) ?? 'tool';
    this.toolTitles.set(id, title);
    const status = str(update.status);
    if (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'failed') {
      this.proc.emit({ type: 'tool-call', id, title, status });
    }
  }

  private onPermission(params: unknown): unknown {
    const request = isRecord(params) ? params : {};
    const toolCall = isRecord(request.toolCall) ? request.toolCall : {};
    const meta = isRecord(toolCall._meta) && isRecord(toolCall._meta.claudeCode) ? toolCall._meta.claudeCode : {};
    const tool = str(meta.toolName) ?? str(toolCall.name) ?? str(toolCall.title) ?? 'tool';
    const decision = permissionDecision(this.provider, this.options.tools, { tool, kind: str(toolCall.kind) });
    this.proc.emit({ type: 'permission', tool, decision });
    const choices = Array.isArray(request.options) ? request.options.filter(isRecord) : [];
    const option = choices.find((choice) => choice.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'));
    if (option === undefined || str(option.optionId) === undefined) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }

  send(message: string): Promise<void> {
    if (this.fatal !== null || this.proc.hasExited())
      return Promise.reject(new Error('The provider process has exited'));
    if (this.sessionId === null) return Promise.reject(new Error('The session is not ready'));
    if (this.promptInFlight) return Promise.reject(new Error('A turn is in flight'));
    this.acceptUpdates = true;
    this.unpromptedActive = false;
    this.promptInFlight = true;
    this.cancelRequested = false;
    this.turnFinished = false;
    this.proc.emit({ type: 'turn-start', prompted: true });
    this.peer
      .request<Rec>('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: message }] })
      .then(
        (result) => {
          const reason = str(result.stopReason) ?? 'end_turn';
          const mapped = STOP_REASONS[reason];
          this.finishTurn(
            mapped === undefined
              ? {
                  stopReason: 'error',
                  error: { code: 'PROVIDER_ERROR', message: `Unexpected stop reason "${reason}".` },
                }
              : { stopReason: mapped },
          );
        },
        (error: unknown) => {
          if (this.peer.closedNow()) return; // the exit handler reports the crash
          this.finishTurn({ stopReason: this.cancelRequested ? 'cancelled' : 'error', error: asRunError(error) });
        },
      );
    return Promise.resolve();
  }

  private finishTurn(end: { stopReason: TurnStopReason; error?: RunError }): void {
    if (this.turnFinished) return;
    this.turnFinished = true;
    this.promptInFlight = false;
    this.proc.emit({ type: 'turn-end', ...end });
  }

  respond(): void {
    // Native questions are declined inside the driver until PR 4.
  }

  cancelTurn(): void {
    if (this.sessionId === null || !this.promptInFlight) return;
    this.cancelRequested = true;
    this.peer.notify('session/cancel', { sessionId: this.sessionId });
  }

  stop(): Promise<ProviderExit> {
    return this.proc.stop();
  }

  kill(): void {
    this.proc.kill();
  }
}
