import { PassThrough } from 'node:stream';
import type { Env, Secrets } from '../../config/load';
import { providerOptions } from '../../config/providers';
import type { Config } from '../../config/schema';
import type { ProviderName, RunError } from '../../domain/types';
import { copilotAuthEnvNames } from '../../runs/childProcess';
import type { ProviderExit } from '../../runs/providerLauncher';
import { INTERACTIVE_CAPABILITIES } from '../capabilities';
import { createJsonRpcPeer, JsonRpcError, JsonRpcTimeoutError } from './jsonRpc';
import {
  asRunError,
  DriverError,
  HANDSHAKE_REQUEST_TIMEOUT_MS,
  type DriverTimings,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type QuestionAnswer,
  type SessionStartOptions,
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

// An unprompted turn (a native timer firing inside the live process) has no start or end signal over ACP (provider
// spike, Claude item i). It ends with the usage_update that carries `cost`, or after this long without any update.
export const AGENT_SETTLE_MS = 5000;
const BOOKKEEPING_UPDATES = new Set([
  'usage_update',
  'session_info_update',
  'available_commands_update',
  'current_mode_update',
]);

type PendingElicitation = {
  choices: { value: string; label: string }[];
  hasCustom: boolean;
  resolve(result: unknown): void;
};

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
  timings: DriverTimings = {},
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
  private settleTimer: NodeJS.Timeout | null = null;
  // Tool calls of the unprompted turn that have not completed or failed: a long tool is silent, not finished.
  private readonly pendingTools = new Set<string>();
  // After a cancelled unprompted turn the adapter may still print its tail; that must not start a new turn.
  private suppressUnprompted = false;
  private quietTimer: NodeJS.Timeout | null = null;
  private readonly agentSettleMs: number;
  private cancelRequested = false;
  private turnFinished = true;
  private fatal: RunError | null = null;
  private readonly toolTitles = new Map<string, string>();
  private readonly requestTimeoutMs: number;
  // Native questions (elicitation/create) are mapped only for providers whose capabilities say so.
  private readonly elicitation: boolean;
  private readonly questions = new Map<string, PendingElicitation>();
  private nextQuestion = 1;

  constructor(
    private readonly provider: AcpProvider,
    private readonly command: AcpCommand,
    secrets: Secrets,
    private readonly options: SessionStartOptions,
    timings: DriverTimings,
  ) {
    const input = new PassThrough();
    this.requestTimeoutMs = timings.requestTimeoutMs ?? HANDSHAKE_REQUEST_TIMEOUT_MS;
    this.agentSettleMs = timings.agentSettleMs ?? AGENT_SETTLE_MS;
    this.elicitation = INTERACTIVE_CAPABILITIES[provider].nativeQuestions === 'acp-elicitation';
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
    // A provider that does not advertise elicitation gets every question declined and logged.
    for (const method of ['elicitation/create', 'session/elicitation']) {
      this.peer.onRequest(method, (params) => {
        if (this.elicitation && method === 'elicitation/create') return this.onElicitation(params);
        const message = isRecord(params) ? str(params.message) : undefined;
        this.proc.log(`declined native question (${method}): ${message ?? ''}`);
        return { action: 'cancel' };
      });
    }
  }

  // A handshake request that is never answered kills the process and fails the start instead of hanging it.
  private async call<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.peer.request<T>(method, params, { timeoutMs: this.requestTimeoutMs });
    } catch (error) {
      if (!(error instanceof JsonRpcTimeoutError)) throw error;
      this.proc.log(`handshake timeout: ${error.message}`);
      this.proc.kill();
      throw new DriverError({
        code: 'PROVIDER_ERROR',
        message: `${providerLabels[this.provider]} did not answer ${method}: ${error.message}. The process was stopped.`,
      });
    }
  }

  private async handshake(): Promise<{ providerSessionId: string }> {
    try {
      const init = await this.call<Rec>('initialize', {
        protocolVersion: 1,
        clientCapabilities: this.elicitation ? { elicitation: { form: {} } } : {},
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
          await this.call('session/load', { sessionId: resumeId, cwd: this.options.cwd, mcpServers });
        } catch (error) {
          if (this.peer.closedNow() || error instanceof DriverError) throw error;
          const detail =
            error instanceof JsonRpcError ? `${error.message} (code ${error.code})` : asRunError(error).message;
          throw new DriverError({
            code: 'SESSION_RESUME_FAILED',
            message: `${providerLabels[this.provider]} could not resume session ${resumeId}: ${detail}`,
          });
        }
        sessionId = resumeId;
      } else {
        const created = await this.call<Rec>('session/new', { cwd: this.options.cwd, mcpServers });
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
      await this.call('session/set_config_option', { sessionId, configId: 'model', value: this.options.model });
    } catch (error) {
      if (this.peer.closedNow() || error instanceof DriverError) throw error;
      throw new DriverError({
        code: 'MODEL_UNSUPPORTED',
        message: `${providerLabels[this.provider]} rejected model "${this.options.model}": ${asRunError(error).message}`,
      });
    }
    // The Claude adapter would otherwise ask for permissions; allowAll maps to its bypass mode (as the one-shot launcher).
    if (this.provider === 'claude-code' && this.options.tools.allowAll) {
      try {
        await this.call('session/set_config_option', {
          sessionId,
          configId: 'mode',
          value: 'bypassPermissions',
        });
      } catch (error) {
        if (this.peer.closedNow() || error instanceof DriverError) throw error;
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
    if (this.unpromptedActive) this.endUnprompted({ stopReason: 'error', error });
    this.liftSuppression();
    if (this.promptInFlight) {
      this.finishTurn(this.cancelRequested ? { stopReason: 'cancelled' } : { stopReason: 'error', error });
    }
    this.proc.emit({ type: 'exit', exit: exit.error === undefined ? exit : { ...exit, error } });
  }

  // Updates that arrive while no prompt is in flight are unprompted turns (native timers). The first update that is
  // not bookkeeping starts one; usage_update with `cost` (or AGENT_SETTLE_MS of silence) ends it.
  private onUpdate(params: unknown): void {
    if (!this.acceptUpdates || !isRecord(params) || !isRecord(params.update)) return;
    const update = params.update;
    const kind = str(update.sessionUpdate) ?? '';
    if (!this.promptInFlight && this.suppressUnprompted) {
      // Tail of a cancelled unprompted turn: swallowed until a final usage_update (with cost) or a quiet period.
      if (kind === 'usage_update' && update.cost !== undefined) this.liftSuppression();
      else this.armQuiet();
      return;
    }
    if (!this.promptInFlight) {
      if (BOOKKEEPING_UPDATES.has(kind)) {
        if (this.unpromptedActive) {
          if (kind === 'usage_update' && update.cost !== undefined) this.endUnprompted({ stopReason: 'end_turn' });
          else this.armSettle();
        }
        return;
      }
      if (!this.unpromptedActive) {
        this.unpromptedActive = true;
        this.proc.emit({ type: 'turn-start', prompted: false });
      }
      this.armSettle();
    }
    // Only text and tool calls are recorded; other updates (thoughts, plans) just keep an unprompted turn alive.
    if (kind !== 'agent_message_chunk' && kind !== 'tool_call' && kind !== 'tool_call_update') return;
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
      if (this.unpromptedActive && !this.promptInFlight) {
        if (status === 'completed' || status === 'failed') this.pendingTools.delete(id);
        else this.pendingTools.add(id);
        this.armSettle();
      }
      this.proc.emit({ type: 'tool-call', id, title, status });
    }
  }

  private armQuiet(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.liftSuppression(), this.agentSettleMs);
    this.quietTimer.unref();
  }

  private liftSuppression(): void {
    this.suppressUnprompted = false;
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  // The silence window only applies while no tool call of the turn is in flight.
  private armSettle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.pendingTools.size > 0) return;
    this.settleTimer = setTimeout(() => this.endUnprompted({ stopReason: 'end_turn' }), this.agentSettleMs);
    this.settleTimer.unref();
  }

  private endUnprompted(end: { stopReason: TurnStopReason; error?: RunError }): void {
    if (!this.unpromptedActive) return;
    this.unpromptedActive = false;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.pendingTools.clear();
    this.toolTitles.clear();
    this.proc.emit({ type: 'turn-end', ...end });
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
    this.endUnprompted({ stopReason: 'end_turn' }); // a prompt supersedes an unprompted turn that is still open
    this.liftSuppression();
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
    this.toolTitles.clear();
    this.cancelQuestions();
    this.proc.emit({ type: 'turn-end', ...end });
  }

  // The form of the spike (Claude item h): question_0 is a string, with `oneOf` {const, title} for choices, and
  // question_0_custom takes free text. Only the first question is mapped; the request stays open until respond().
  private onElicitation(params: unknown): Promise<unknown> {
    const request = isRecord(params) ? params : {};
    const schema = isRecord(request.requestedSchema) ? request.requestedSchema : {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const field = isRecord(properties.question_0) ? properties.question_0 : {};
    const choices = (Array.isArray(field.oneOf) ? field.oneOf : []).filter(isRecord).flatMap((choice) => {
      const value = str(choice.const);
      return value === undefined ? [] : [{ value, label: str(choice.title) ?? value }];
    });
    const text = str(request.message) ?? str(field.title) ?? '';
    const requestId = `elicitation-${this.nextQuestion++}`;
    return new Promise((resolve) => {
      this.questions.set(requestId, {
        choices,
        hasCustom: isRecord(properties.question_0_custom),
        resolve,
      });
      this.proc.emit({
        type: 'question',
        requestId,
        text,
        options: choices.length > 0 ? choices.map((choice) => choice.label) : null,
      });
    });
  }

  respond(requestId: string, answer: QuestionAnswer): void {
    const pending = this.questions.get(requestId);
    if (pending === undefined) return;
    this.questions.delete(requestId);
    if (answer.kind === 'cancel') return pending.resolve({ action: 'cancel' });
    const choice = pending.choices.find(
      (candidate) => candidate.label === answer.text || candidate.value === answer.text,
    );
    if (answer.kind === 'answer' && choice !== undefined) {
      return pending.resolve({ action: 'accept', content: { question_0: choice.value } });
    }
    // Free text, and the timeout reply (verified in the PR 4 spike: the model then stops and ends its turn).
    if (pending.hasCustom) return pending.resolve({ action: 'accept', content: { question_0_custom: answer.text } });
    if (answer.kind === 'answer' && pending.choices.length === 0) {
      return pending.resolve({ action: 'accept', content: { question_0: answer.text } });
    }
    pending.resolve({ action: 'cancel' });
  }

  private cancelQuestions(): void {
    for (const pending of this.questions.values()) pending.resolve({ action: 'cancel' });
    this.questions.clear();
  }

  cancelTurn(): void {
    if (this.sessionId !== null && this.unpromptedActive && !this.promptInFlight) {
      this.peer.notify('session/cancel', { sessionId: this.sessionId });
      this.endUnprompted({ stopReason: 'cancelled' });
      this.suppressUnprompted = true;
      this.armQuiet();
      return;
    }
    if (this.sessionId === null || !this.promptInFlight) return;
    this.cancelRequested = true;
    this.peer.notify('session/cancel', { sessionId: this.sessionId });
    this.cancelQuestions();
  }

  stop(): Promise<ProviderExit> {
    return this.proc.stop();
  }

  kill(): void {
    this.proc.kill();
  }
}
