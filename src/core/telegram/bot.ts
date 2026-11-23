import type { AccessService } from '../access/accessService';
import type { AppError } from '../domain/result';
import type { Clock, Run } from '../domain/types';
import type { ProjectService } from '../projects/projectService';
import type { QueueService } from '../queue/queueService';
import type { ReadModels } from '../read-models/index';
import type { UserService } from '../users/userService';
import type { WatchService } from '../watches/watchService';
import type { InlineKeyboard, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './api';
import { kindLabel, oneLine, runStatusLabel, splitMessage, stateLabel, timeAgo, truncate } from './format';
import type { TelegramStore, Wizard } from './store';

export interface TelegramServices {
  clock: Clock;
  users: UserService;
  access: AccessService;
  read: ReadModels;
  watches: WatchService;
  queue: QueueService;
  projects: ProjectService;
}

export interface TelegramBotOptions {
  api: TelegramApi;
  store: TelegramStore;
  services: TelegramServices;
  dashboardUrl: string;
  log?: (line: string) => void;
}

const LIST_LIMIT = 20;
const CHAT_LIMIT = 10;
const RUNS_SHOWN = 5;
const THREAD_TURNS = 6;

const HELP = [
  'Automator bot',
  '/watches - open Automations (needs you first)',
  '/watch <id> - Automation details',
  '/run <n> - a Run and its result',
  '/project - choose the active Project',
  '/chat - start a chat',
  '/chats - your last 10 chats',
  '/cancel - leave the current flow',
  '/login <access token> - link this Telegram account',
  '/logout - unlink this Telegram account',
  'Plain text continues the current chat.',
].join('\n');

export function describeError(error: AppError): string {
  switch (error.code) {
    case 'FORBIDDEN':
      return 'You are not allowed to do that.';
    case 'NOT_FOUND':
      return 'Not found.';
    case 'INVALID_INPUT':
      return error.message;
    case 'INVALID_STATE':
      return `Not possible while it is ${error.state}.`;
    case 'RUN_IN_PROGRESS':
      return `Run #${error.runId} is in progress.`;
    case 'JIRA_DISABLED':
      return 'Jira is disabled for this Repository.';
    case 'UNKNOWN_REPOSITORY':
      return `Unknown Repository "${error.name}".`;
    case 'INVALID_TARGET':
      return error.message;
    default:
      return `Request failed (${error.code}).`;
  }
}

const parseCommand = (text: string): { command: string; arg: string } | null => {
  const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m === null ? null : { command: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() };
};

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly store: TelegramStore;
  private readonly s: TelegramServices;
  private readonly dashboardUrl: string;
  private readonly log: (line: string) => void;

  constructor(options: TelegramBotOptions) {
    this.api = options.api;
    this.store = options.store;
    this.s = options.services;
    this.dashboardUrl = options.dashboardUrl.replace(/\/+$/, '');
    this.log = options.log ?? (() => {});
  }

  async say(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const parts = splitMessage(text);
    for (const [i, part] of parts.entries())
      await this.api.sendMessage(chatId, part, i === parts.length - 1 ? keyboard : undefined);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    try {
      if (update.message !== undefined) await this.onMessage(update.message);
      else if (update.callback_query !== undefined) await this.onCallback(update.callback_query);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`telegram handler failed: ${message}`);
      if (chatId !== undefined) {
        await this.api
          .sendMessage(chatId, `⚠️ Automator could not handle that: ${oneLine(message, 300)}`)
          .catch(() => {});
      }
    }
  }

  // The linked user acting in this chat, or null after unlinking an account whose token is no longer valid.
  private async authorized(telegramUserId: number, chatId: number): Promise<number | null> {
    const link = this.store.link(telegramUserId);
    if (link === null) return null;
    if (!this.s.users.isFingerprintValid(link.userId, link.tokenFingerprint)) {
      this.store.unlink(telegramUserId);
      await this.api.sendMessage(
        chatId,
        'Your access token is no longer valid, so this chat was unlinked. Send /login <access token> to link it again.',
      );
      return null;
    }
    return link.userId;
  }

  private async onMessage(message: TelegramMessage): Promise<void> {
    if (message.chat.type !== 'private' || message.from === undefined || message.text === undefined) return;
    const chatId = message.chat.id;
    const text = message.text;
    const cmd = parseCommand(text);

    if (cmd?.command === 'login') return this.login(message, cmd.arg);
    if (cmd?.command === 'start' || cmd?.command === 'help') {
      if (this.store.link(message.from.id) === null) {
        return this.say(
          chatId,
          'Send /login <access token> (create one in Automator under Account → Access tokens). Your message is deleted right away.',
        );
      }
    }

    const wasLinked = this.store.link(message.from.id) !== null;
    const userId = await this.authorized(message.from.id, chatId);
    if (userId === null) {
      if (!wasLinked && cmd?.command !== 'start' && cmd?.command !== 'help')
        await this.say(chatId, 'Not logged in. Send /login <access token> with an access token from Automator.');
      return;
    }

    if (cmd !== null) return this.command(chatId, userId, message.from.id, cmd.command, cmd.arg);
    return this.plainText(chatId, userId, text);
  }

  private async login(message: TelegramMessage, token: string): Promise<void> {
    const chatId = message.chat.id;
    // The token must not stay in the chat history.
    const deleted = await this.api.deleteMessage(chatId, message.message_id).then(
      () => true,
      () => false,
    );
    const auth = token === '' ? null : this.s.users.authenticateToken(token);
    if (auth === null) {
      await this.say(
        chatId,
        'That access token is invalid, expired or revoked. Create a new one in Automator and send /login <access token>.',
      );
      return;
    }
    this.store.setLink(message.from!.id, chatId, auth.user.id, auth.fingerprint);
    this.store.saveChatState(chatId, { projectId: null, currentRunId: null, wizard: null });
    const note = deleted
      ? 'I deleted your token message.'
      : '⚠️ I could not delete your token message. Delete it yourself now and consider revoking the token in Automator and creating a new one.';
    await this.say(chatId, `Logged in as ${auth.user.username}. ${note}\n\n${HELP}`);
  }

  private async command(
    chatId: number,
    userId: number,
    telegramUserId: number,
    command: string,
    arg: string,
  ): Promise<void> {
    if (command !== 'chat' && command !== 'cancel') this.store.saveChatState(chatId, { wizard: null });
    switch (command) {
      case 'start':
      case 'help':
        return this.say(chatId, HELP);
      case 'logout':
        this.store.unlink(telegramUserId);
        return this.say(chatId, 'Logged out. Your token was not stored.');
      case 'cancel':
        this.store.saveChatState(chatId, { wizard: null });
        return this.say(chatId, 'Cancelled.');
      case 'watches':
        return this.watchList(chatId, userId);
      case 'watch':
      case 'automation':
        return /^\d+$/.test(arg)
          ? this.watchDetail(chatId, userId, Number(arg))
          : this.say(chatId, 'Usage: /watch <id>');
      case 'run':
        return /^#?\d+$/.test(arg)
          ? this.runDetail(chatId, userId, Number(arg.replace('#', '')))
          : this.say(chatId, 'Usage: /run <n>');
      case 'project':
        return this.projectPicker(chatId, userId);
      case 'chats':
        return this.chatList(chatId, userId);
      case 'chat':
        return this.startWizard(chatId, userId);
      default:
        return this.say(chatId, `Unknown command /${command}.\n\n${HELP}`);
    }
  }

  private async onCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined || query.data === undefined) return;
    const userId = await this.authorized(query.from.id, chatId);
    if (userId === null) {
      await this.api.answerCallbackQuery(query.id, 'Not logged in').catch(() => {});
      return;
    }
    await this.api.answerCallbackQuery(query.id).catch(() => {});
    const [kind, ...rest] = query.data.split(':');
    const arg = rest.join(':');
    switch (kind) {
      case 'w':
        return this.watchDetail(chatId, userId, Number(arg));
      case 'r':
        return this.runDetail(chatId, userId, Number(arg));
      case 'p':
        return this.pickProject(chatId, userId, arg);
      case 'c':
        return this.openChat(chatId, userId, Number(arg));
      case 'a':
        return this.watchAction(chatId, userId, arg);
      case 'wz':
        return this.wizardCallback(chatId, userId, arg);
      default:
        return this.say(chatId, 'That button is no longer valid.');
    }
  }

  // --- scope -------------------------------------------------------------------------------------------------------

  private scope(chatId: number, userId: number) {
    const projectId = this.store.chatState(chatId).projectId;
    return this.s.access.readScope(
      userId,
      projectId,
      this.s.projects.list().map((p) => p.id),
    );
  }

  private projectName(chatId: number): string | null {
    const id = this.store.chatState(chatId).projectId;
    return id === null ? null : (this.s.projects.get(id)?.name ?? null);
  }

  // --- Automations -------------------------------------------------------------------------------------------------

  private async watchList(chatId: number, userId: number): Promise<void> {
    const view = this.s.read.watchList({ project: this.scope(chatId, userId) });
    const open = view.rows.filter((r) => r.state !== 'closed'); // rows are already ordered with needs-you first
    const project = this.projectName(chatId);
    const heading = `Open Automations${project === null ? '' : ` in ${project}`}: ${open.length}`;
    if (open.length === 0) return this.say(chatId, `${heading}\nNothing to follow up.`);
    const shown = open.slice(0, LIST_LIMIT);
    const lines = shown.map(
      (r) => `#${r.id} ${stateLabel(r.state)} · ${kindLabel(r.kind)}\n${oneLine(r.title, 80)}\n${r.targetUrl}`,
    );
    const more =
      open.length > shown.length ? `\n…and ${open.length - shown.length} more (use /project to narrow down).` : '';
    await this.say(
      chatId,
      `${heading}\n\n${lines.join('\n\n')}${more}`,
      shown.map((r) => [{ text: `#${r.id} ${oneLine(r.title, 40)}`, data: `w:${r.id}` }]),
    );
  }

  private async watchDetail(chatId: number, userId: number, id: number): Promise<void> {
    if (!this.s.access.canOnWatch(userId, 'read', id)) return this.say(chatId, `Automation #${id} not found.`);
    const view = this.s.read.watchDetail(id);
    if (view === null) return this.say(chatId, `Automation #${id} not found.`);
    const { watch } = view;
    const now = this.s.clock.now();
    const lines = [
      `#${watch.id} ${oneLine(watch.name ?? watch.title, 100)}`,
      watch.targetUrl,
      `${stateLabel(watch.state)} · ${kindLabel(watch.kind)} · ${watch.repository}`,
    ];
    if (watch.state === 'needs_you' && watch.needsYouReason !== null) lines.push(`Needs you: ${watch.needsYouReason}`);
    if (view.running !== null) lines.push('A Run is in progress.');
    const runs = view.runs.slice(0, RUNS_SHOWN);
    lines.push('', runs.length === 0 ? 'No Runs yet.' : 'Latest Runs:');
    for (const r of runs)
      lines.push(
        `#${r.id} ${runStatusLabel(r)} · ${timeAgo(r.endedAt ?? r.queuedAt, now)}${r.summary ? ` · ${oneLine(r.summary, 60)}` : ''}`,
      );
    lines.push('', `${this.dashboardUrl}/automations/${watch.id}`);

    const can = this.s.access.canOnWatch(userId, 'write', id);
    const keyboard: InlineKeyboard = runs.map((r) => [{ text: `Run #${r.id}`, data: `r:${r.id}` }]);
    if (can) {
      const buttons = {
        pause: { text: '⏸ Pause', data: `a:pause:${id}` },
        resume: { text: '▶️ Resume', data: `a:resume:${id}` },
        close: { text: '✖️ Close', data: `a:close:${id}` },
        runNow: { text: '⚡ Run now', data: `a:run:${id}` },
      } as const;
      const row = (['pause', 'resume', 'runNow', 'close'] as const)
        .filter((a) => view.actions.includes(a))
        .map((a) => buttons[a]);
      if (row.length > 0) keyboard.push(row);
    }
    await this.say(chatId, lines.join('\n'), keyboard);
  }

  private async watchAction(chatId: number, userId: number, arg: string): Promise<void> {
    const [action, rawId] = arg.split(':');
    const id = Number(rawId);
    if (!Number.isInteger(id)) return this.say(chatId, 'That button is no longer valid.');
    // Every action is checked on the server for the linked user; the buttons are only a convenience.
    if (!this.s.access.canOnWatch(userId, 'write', id)) return this.say(chatId, describeError({ code: 'FORBIDDEN' }));
    if (action === 'close') {
      return this.say(chatId, `Close Automation #${id}? This ends its follow-up.`, [
        [
          { text: 'Yes, close', data: `a:closeok:${id}` },
          { text: 'Keep it', data: `w:${id}` },
        ],
      ]);
    }
    const result =
      action === 'pause'
        ? this.s.watches.pause(id)
        : action === 'resume'
          ? this.s.watches.resume(id, {})
          : action === 'closeok'
            ? this.s.watches.close(id)
            : action === 'run'
              ? this.s.watches.runNow(id, {})
              : null;
    if (result === null) return this.say(chatId, 'That button is no longer valid.');
    if (!result.ok) return this.say(chatId, `⚠️ ${describeError(result.error)}`);
    const done = { pause: 'Paused', resume: 'Resumed', closeok: 'Closed', run: 'Run queued for' }[action!]!;
    await this.say(chatId, `${done} Automation #${id}.`);
    if (action !== 'closeok') await this.watchDetail(chatId, userId, id);
  }

  // --- Runs ----------------------------------------------------------------------------------------------------------

  private async runDetail(chatId: number, userId: number, id: number): Promise<void> {
    if (!Number.isInteger(id) || !this.s.access.canOnRun(userId, 'read', id))
      return this.say(chatId, `Run #${id} not found.`);
    const view = await this.s.read.runDetail(id);
    if (view === null) return this.say(chatId, `Run #${id} not found.`);
    const { run } = view;
    const lines = [
      `Run #${run.id} · ${runStatusLabel(run)}`,
      run.watchId === null
        ? `Chat in ${run.repository}`
        : `Automation #${run.watchId}${view.watchTitle ? `: ${oneLine(view.watchTitle, 80)}` : ''}`,
    ];
    if (run.outcome !== null) lines.push(`Outcome: ${run.outcome}`);
    if (run.summary) {
      const { text, truncated } = truncate(run.summary);
      lines.push('', text, ...(truncated ? ['(truncated - see the dashboard for the full result)'] : []));
    }
    if (run.error !== null) lines.push('', `Error: ${truncate(run.error.message, 1500).text}`);
    lines.push('', `${this.dashboardUrl}/runs/${run.id}`);
    await this.say(chatId, lines.join('\n'));
  }

  // --- Projects --------------------------------------------------------------------------------------------------

  private async projectPicker(chatId: number, userId: number): Promise<void> {
    const projects = this.s.projects.list();
    const readable = new Set(
      this.s.access.readableProjectIds(
        userId,
        projects.map((p) => p.id),
      ),
    );
    const choices = projects.filter((p) => readable.has(p.id));
    const current = this.projectName(chatId);
    const keyboard: InlineKeyboard = [
      [{ text: 'All projects', data: 'p:all' }],
      ...choices.map((p) => [{ text: p.name, data: `p:${p.id}` }]),
    ];
    await this.say(
      chatId,
      `Active Project: ${current ?? 'all projects'}.\nPick one to scope lists and new chats.`,
      keyboard,
    );
  }

  private async pickProject(chatId: number, userId: number, arg: string): Promise<void> {
    if (arg === 'all') {
      this.store.saveChatState(chatId, { projectId: null });
      return this.say(chatId, 'Showing all projects.');
    }
    const id = Number(arg);
    const project = this.s.projects.get(id);
    if (project === null || !this.s.access.can(userId, 'read', id)) return this.say(chatId, 'Project not found.');
    this.store.saveChatState(chatId, { projectId: id });
    await this.say(chatId, `Active Project: ${project.name}.`);
  }

  // --- Chats -----------------------------------------------------------------------------------------------------

  private async chatList(chatId: number, userId: number): Promise<void> {
    // Only the user's own chats (the run owner), like the chat-finished pushes. runList applies its limit before
    // this filter, so it is read unlimited and cut here.
    const rows = this.s.read
      .runList({ project: this.scope(chatId, userId) })
      .filter((r) => this.s.access.ownerOf('runs', r.id) === userId)
      .slice(0, CHAT_LIMIT);
    if (rows.length === 0) return this.say(chatId, 'You have no chats yet. Start one with /chat.');
    const now = this.s.clock.now();
    const lines = rows.map(
      (r) =>
        `#${r.id} ${runStatusLabel(r)} · ${r.repository} · ${timeAgo(r.endedAt ?? r.queuedAt, now)}\n${oneLine(r.adhocPrompt ?? r.ticket?.key ?? '', 80)}`,
    );
    await this.say(
      chatId,
      `Your last ${rows.length} chats:\n\n${lines.join('\n\n')}`,
      rows.map((r) => [
        { text: `#${r.id} ${oneLine(r.adhocPrompt ?? r.ticket?.key ?? r.repository, 40)}`, data: `c:${r.id}` },
      ]),
    );
  }

  private async openChat(chatId: number, userId: number, runId: number): Promise<void> {
    if (!Number.isInteger(runId) || !this.s.access.canOnRun(userId, 'read', runId))
      return this.say(chatId, `Chat #${runId} not found.`);
    const view = await this.s.read.runDetail(runId);
    if (view === null || view.thread === null) return this.say(chatId, `Chat #${runId} not found.`);
    const { thread } = view;
    const turns = thread.runs.slice(-THREAD_TURNS);
    const lines: string[] = [];
    for (const t of turns) {
      if (t.request) lines.push(`You: ${truncate(t.request, 1200).text}`);
      const reply = t.summary ?? t.error?.message ?? (t.status === 'finished' ? '(no reply)' : `(${t.status}…)`);
      lines.push(`Agent (#${t.id}): ${truncate(reply, 1500).text}`);
    }
    const tip = thread.runs[thread.runs.length - 1]!;
    this.store.saveChatState(chatId, { currentRunId: tip.id, wizard: null });
    const hint =
      thread.replyToRunId !== null ? 'Send a message to continue this chat.' : blockedText(thread.replyBlockedReason);
    await this.say(chatId, `${lines.join('\n\n')}\n\n${hint}\n${this.dashboardUrl}/runs/${tip.id}`);
  }

  private async plainText(chatId: number, userId: number, text: string): Promise<void> {
    const state = this.store.chatState(chatId);
    if (state.wizard !== null) return this.wizardText(chatId, userId, state.wizard, text);
    if (state.currentRunId === null)
      return this.say(chatId, 'No chat is open. Start one with /chat or open one from /chats.');
    const view = await this.s.read.runDetail(state.currentRunId);
    if (view?.thread == null) return this.say(chatId, 'That chat is gone. Start one with /chat.');
    const tipId = view.thread.replyToRunId;
    if (tipId === null) return this.say(chatId, blockedText(view.thread.replyBlockedReason));
    if (!this.s.access.canOnRun(userId, 'write', tipId)) return this.say(chatId, describeError({ code: 'FORBIDDEN' }));
    const result = this.s.queue.requestFollowUp(tipId, text);
    if (!result.ok) return this.say(chatId, `⚠️ ${describeError(result.error)}`);
    this.s.access.setOwner('runs', result.value.run.id, userId);
    this.store.saveChatState(chatId, { currentRunId: result.value.run.id });
    await this.say(chatId, `Queued as Run #${result.value.run.id}. I will message you when it finishes.`);
  }

  // --- /chat wizard ----------------------------------------------------------------------------------------------

  private writableRepositories(chatId: number, userId: number): string[] {
    const options = this.s.read.formOptions(this.scope(chatId, userId));
    return options.repositories
      .map((r) => r.name)
      .filter((name) => this.s.access.canOnRepository(userId, 'write', name));
  }

  private async startWizard(chatId: number, userId: number): Promise<void> {
    const repositories = this.writableRepositories(chatId, userId);
    if (repositories.length === 0)
      return this.say(chatId, 'No Repository available here. Check /project or your permissions.');
    this.store.saveChatState(chatId, { wizard: { step: 'repository' } });
    const project = this.projectName(chatId);
    await this.say(chatId, `New chat${project === null ? '' : ` in ${project}`}. Which Repository?`, [
      ...repositories.map((name, i) => [{ text: name, data: `wz:repo:${i}` }]),
      [{ text: 'Cancel', data: 'wz:cancel' }],
    ]);
  }

  private async askTicket(chatId: number, repository: string): Promise<void> {
    this.store.saveChatState(chatId, { wizard: { step: 'ticket', repository } });
    await this.say(chatId, `Repository: ${repository}.\nLink a Jira ticket? Send its key (e.g. ABC-123) or skip.`, [
      [
        { text: 'Skip', data: 'wz:skip' },
        { text: 'Cancel', data: 'wz:cancel' },
      ],
    ]);
  }

  private async askOptions(chatId: number, wizard: Extract<Wizard, { step: 'options' }>): Promise<void> {
    this.store.saveChatState(chatId, { wizard });
    const options = this.s.read.formOptions(null);
    const settings = options.byRepository[wizard.repository] ?? options;
    const agent = options.agents.find((a) => a.id === wizard.agentId);
    const keyboard: InlineKeyboard = [
      [{ text: '➡️ Continue', data: 'wz:go' }],
      ...settings.models.map((m, i) => [
        { text: `${m === (wizard.model ?? settings.defaultModel) ? '✅ ' : ''}${m}`, data: `wz:model:${i}` },
      ]),
      ...options.agents.map((a) => [
        { text: `${a.id === wizard.agentId ? '✅ ' : ''}Agent: ${a.name}`, data: `wz:agent:${a.id}` },
      ]),
    ];
    if (wizard.agentId !== null) keyboard.push([{ text: 'Default agent', data: 'wz:agent:none' }]);
    keyboard.push([{ text: 'Cancel', data: 'wz:cancel' }]);
    await this.say(
      chatId,
      `Model: ${wizard.model ?? settings.defaultModel}${wizard.model === null ? ' (default)' : ''}\nAgent: ${agent?.name ?? 'default'}\nChange them below or continue.`,
      keyboard,
    );
  }

  private async askPrompt(chatId: number, wizard: Extract<Wizard, { step: 'options' }>): Promise<void> {
    this.store.saveChatState(chatId, { wizard: { ...wizard, step: 'prompt' } });
    await this.say(
      chatId,
      'What should the agent do? Send your first message.',
      wizard.ticket === null
        ? [[{ text: 'Cancel', data: 'wz:cancel' }]]
        : [[{ text: 'Start with the ticket only', data: 'wz:start' }], [{ text: 'Cancel', data: 'wz:cancel' }]],
    );
  }

  private async wizardCallback(chatId: number, userId: number, arg: string): Promise<void> {
    const wizard = this.store.chatState(chatId).wizard;
    if (arg === 'cancel') {
      this.store.saveChatState(chatId, { wizard: null });
      return this.say(chatId, 'Cancelled.');
    }
    if (wizard === null) return this.say(chatId, 'That flow has ended. Start again with /chat.');
    const [kind, value] = arg.split(':');
    if (wizard.step === 'repository' && kind === 'repo') {
      const repository = this.writableRepositories(chatId, userId)[Number(value)];
      if (repository === undefined)
        return this.say(chatId, 'That Repository is no longer available. Start again with /chat.');
      return this.askTicket(chatId, repository);
    }
    if (wizard.step === 'ticket' && kind === 'skip')
      return this.askOptions(chatId, {
        step: 'options',
        repository: wizard.repository,
        ticket: null,
        model: null,
        agentId: null,
      });
    if (wizard.step === 'options') {
      if (kind === 'model') {
        const model = this.s.read.formOptions(null).byRepository[wizard.repository]?.models[Number(value)];
        if (model === undefined) return this.say(chatId, 'That model is not available.');
        return this.askOptions(chatId, { ...wizard, model });
      }
      if (kind === 'agent')
        return this.askOptions(chatId, { ...wizard, agentId: value === 'none' ? null : Number(value) });
      if (kind === 'go') return this.askPrompt(chatId, wizard);
    }
    if (wizard.step === 'prompt' && kind === 'start') return this.submitChat(chatId, userId, wizard, null);
    await this.say(chatId, 'That button is no longer valid.');
  }

  private async wizardText(chatId: number, userId: number, wizard: Wizard, text: string): Promise<void> {
    if (wizard.step === 'repository') {
      const repository = this.writableRepositories(chatId, userId).find(
        (r) => r.toLowerCase() === text.trim().toLowerCase(),
      );
      return repository === undefined
        ? this.say(chatId, 'Pick a Repository with the buttons, or /cancel.')
        : this.askTicket(chatId, repository);
    }
    if (wizard.step === 'ticket')
      return this.askOptions(chatId, {
        step: 'options',
        repository: wizard.repository,
        ticket: text.trim(),
        model: null,
        agentId: null,
      });
    if (wizard.step === 'options') return this.say(chatId, 'Choose with the buttons and press Continue, or /cancel.');
    return this.submitChat(chatId, userId, wizard, text);
  }

  private async submitChat(
    chatId: number,
    userId: number,
    wizard: Extract<Wizard, { step: 'prompt' }>,
    prompt: string | null,
  ): Promise<void> {
    if (!this.s.access.canOnRepository(userId, 'write', wizard.repository))
      return this.say(chatId, describeError({ code: 'FORBIDDEN' }));
    const result = await this.s.queue.requestAdhoc({
      repository: wizard.repository,
      mode: 'follow-up',
      ...(prompt === null ? {} : { prompt }),
      ...(wizard.ticket === null ? {} : { ticket: wizard.ticket }),
      ...(wizard.model === null ? {} : { model: wizard.model }),
      ...(wizard.agentId === null ? {} : { agentId: wizard.agentId }),
    });
    if (!result.ok) {
      // Keep the wizard open on the prompt step so the user can fix the input (for example a wrong ticket key).
      const ticketProblem = result.error.code === 'INVALID_INPUT' && result.error.field === 'ticket';
      if (ticketProblem) {
        this.store.saveChatState(chatId, { wizard: { step: 'ticket', repository: wizard.repository } });
        return this.say(chatId, `⚠️ ${describeError(result.error)}\nSend a valid ticket key or skip.`, [
          [{ text: 'Skip', data: 'wz:skip' }],
        ]);
      }
      return this.say(chatId, `⚠️ ${describeError(result.error)}`);
    }
    const run: Run = result.value.run;
    this.s.access.setOwner('runs', run.id, userId);
    this.store.saveChatState(chatId, { wizard: null, currentRunId: run.id });
    const warning = result.value.warning === undefined ? '' : `\n⚠️ ${result.value.warning}`;
    await this.say(
      chatId,
      `Chat started as Run #${run.id}. I will message you when it finishes; then send a message to continue.${warning}\n${this.dashboardUrl}/runs/${run.id}`,
    );
  }
}

function blockedText(reason: { code: string; runId?: number } | null): string {
  switch (reason?.code) {
    case 'run-unfinished':
      return `Run #${reason.runId} is still running. I will message you when it finishes.`;
    case 'chat-closed':
    case 'chat-closing':
      return 'This chat is closed.';
    case 'waiting-answer':
      return 'The agent is waiting for an answer in the dashboard.';
    case 'no-session':
      return 'This chat has no provider session to continue.';
    default:
      return 'This chat cannot take a reply right now.';
  }
}
