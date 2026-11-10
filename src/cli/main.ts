import fs from 'node:fs';
import path from 'node:path';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  bootstrap,
  formatDuration,
  intervalFor,
  parseDuration,
  type AppError,
  type Core,
  type Run,
  type WatchState,
} from '@core/index';

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  confirm(prompt: string): Promise<boolean>;
}

const USAGE_ERROR = 2;
const DOMAIN_ERROR = 1;
const WATCH_STATES: WatchState[] = ['active', 'paused', 'needs_you', 'closed'];

function durationArg(value: string): number {
  try {
    return parseDuration(value);
  } catch (e) {
    throw new InvalidArgumentError((e as Error).message);
  }
}

function idArg(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Expected a numeric ID.');
  return Number(value);
}

// "@path" reads the text from a file; anything else is the text itself.
function textOrFileArg(value: string): string {
  if (!value.startsWith('@')) return value;
  const file = value.slice(1);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new InvalidArgumentError(`Cannot read ${file}: ${(e as Error).message}`);
  }
}

function describeError(error: AppError, ctx: { watchId?: number; unknownRepoOutcome?: string }): string {
  switch (error.code) {
    case 'UNKNOWN_REPOSITORY': {
      const file =
        error.attemptFile === null
          ? `Result file could not be written: ${error.attemptFileError}`
          : `Result file: ${error.attemptFile}`;
      return `Unknown Repository "${error.name}". ${ctx.unknownRepoOutcome} Known: ${error.known.join(', ')}. ${file}`;
    }
    case 'DUPLICATE_WATCH':
      return `Already automated: Automation #${error.existing.id} (${error.existing.state}, every ${formatDuration(error.existing.intervalMs)})`;
    case 'RUN_IN_PROGRESS':
      return 'Cancel the running Run first';
    case 'INVALID_TARGET':
    case 'INVALID_INPUT':
    case 'RESTART_FAILED':
      return error.message;
    case 'MISSING_INSTRUCTIONS':
      return 'Free-form Automations need --instructions';
    case 'INVALID_STATE':
      return `Automation #${ctx.watchId} is ${error.state}; cannot ${error.action}`;
    case 'JIRA_DISABLED':
      return 'Jira checking is disabled (jira.enabled is false)';
    case 'FORBIDDEN':
      return 'Permission denied';
    case 'NOT_FOUND':
      return `Automation #${ctx.watchId} not found`;
  }
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) =>
    r
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join('  ')
      .trimEnd(),
  );
}

export async function runCli(argv: string[], io: CliIo, core?: Core): Promise<number> {
  let owned: Core | undefined;
  const getCore = (): Core => core ?? (owned ??= bootstrap());
  let code = 0;
  const fail = (error: AppError, ctx: Parameters<typeof describeError>[1] = {}) => {
    io.err(describeError(error, ctx));
    code = DOMAIN_ERROR;
  };
  const queued = (run: Run) => io.out(`Run #${run.id} queued (position ${getCore().queue.position(run.id)})`);

  const program = new Command('automator')
    .description('Manage Automator Automations and Runs')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  const watch = program.command('automation').alias('watch').description('Manage Automations');

  program
    .command('prompts')
    .description('Manage prompt profiles')
    .command('import-legacy')
    .description('Import legacy prompt files into local Agent profiles')
    .requiredOption('--repo <name>', 'Repository name from the config')
    .option('--source <directory>', 'directory containing legacy prompt files')
    .action(async (opts: { repo: string; source?: string }) => {
      const current = getCore();
      if (opts.repo !== 'inspire-mbdp-pages') {
        io.err('Legacy prompt import is only supported for Repository "inspire-mbdp-pages".');
        code = DOMAIN_ERROR;
        return;
      }
      if (current.repositories.get(opts.repo) === null) {
        io.err(
          `Unknown Repository "${opts.repo}". Known: ${current.repositories
            .list()
            .map((repository) => repository.name)
            .sort()
            .join(', ')}`,
        );
        code = DOMAIN_ERROR;
        return;
      }
      const repositoryIssues = current.repositories.status(opts.repo);
      if (repositoryIssues.length > 0) {
        io.err(`Repository "${opts.repo}" is invalid: ${repositoryIssues.join('; ')}`);
        code = DOMAIN_ERROR;
        return;
      }

      const source =
        opts.source === undefined ? path.join(current.config.configDir, 'prompts') : path.resolve(opts.source);
      const promptFiles = {
        'mr-watch': 'mr.md',
        'jira-watch': 'jira.md',
        'ticket-adhoc': 'jira-adhoc.md',
      } as const;
      const prompts = {} as Record<keyof typeof promptFiles, string>;
      for (const [workflowType, filename] of Object.entries(promptFiles) as [keyof typeof promptFiles, string][]) {
        const file = path.join(source, filename);
        try {
          prompts[workflowType] = fs.readFileSync(file, 'utf8');
        } catch (e) {
          throw new Error(`Cannot read legacy prompt file ${file}: ${(e as Error).message}`, { cause: e });
        }
      }

      io.out(`Legacy prompt source: ${source}`);
      io.out(`SQLite database: ${current.dataDir.db}`);
      io.out(`Repository: ${opts.repo}`);
      if (!(await io.confirm('Import these legacy prompts?'))) {
        io.out('Import cancelled; no changes made.');
        return;
      }

      const result = current.agents.importLegacyPrompts(opts.repo, prompts);
      io.out(
        result === 'imported'
          ? `Legacy prompts imported for Repository ${opts.repo}.`
          : `Legacy prompts were already imported for Repository ${opts.repo}.`,
      );
    });

  watch
    .command('add <target>')
    .description('Create an Automation for an MR, Jira ticket or other URL')
    .requiredOption('--repo <name>', 'Repository name from the config')
    .option('--interval <duration>', 'check interval, e.g. 30m', durationArg)
    .option('--model <model>', 'model configured for the selected provider')
    .option('--instructions <text|@file>', 'instructions (required for free-form Automations)', textOrFileArg)
    .addOption(
      new Option('--initial-review <mode>', 'how existing comments are handled').choices([
        'baseline-only',
        'unresolved',
      ]),
    )
    .action(
      (
        target: string,
        opts: {
          repo: string;
          interval?: number;
          model?: string;
          instructions?: string;
          initialReview?: 'baseline-only' | 'unresolved';
        },
      ) => {
        const r = getCore().watches.create({
          target,
          repository: opts.repo,
          intervalMs: opts.interval,
          model: opts.model,
          instructions: opts.instructions,
          initialReview: opts.initialReview,
        });
        if (!r.ok) return fail(r.error, { unknownRepoOutcome: 'No Automation was created.' });
        io.out(`Automation #${r.value.id} created (${r.value.kind}, ${r.value.repository})`);
      },
    );

  watch
    .command('list')
    .description('List Automations')
    .addOption(new Option('--state <state>', 'only Automations in this state').choices(WATCH_STATES))
    .option('--repo <name>', 'only Automations for this Repository')
    .action((opts: { state?: WatchState; repo?: string }) => {
      const { watches, config } = getCore();
      const rows = watches
        .list({ state: opts.state, repository: opts.repo })
        .map((w) => [String(w.id), w.state, w.kind, w.repository, formatDuration(intervalFor(w, config)), w.targetUrl]);
      for (const line of table([['ID', 'STATE', 'KIND', 'REPOSITORY', 'EVERY', 'TARGET'], ...rows])) io.out(line);
    });

  watch
    .command('rm')
    .description('Delete an Automation and its Runs')
    .argument('<id>', 'Automation ID', idArg)
    .action((id: number) => {
      const r = getCore().watches.delete(id);
      if (!r.ok) return fail(r.error, { watchId: id });
      io.out(`Automation #${id} deleted`);
    });

  program
    .command('run')
    .description('Queue an ad-hoc Run')
    .requiredOption('--repo <name>', 'Repository name from the config')
    .option(
      '--prompt <text|@file>',
      'prompt for the selected provider (optional when --ticket is given)',
      textOrFileArg,
    )
    .option('--ticket <key|url>', 'Ticket to work on (Jira key or any URL)')
    .option('--model <model>', 'model configured for the selected provider')
    .action(async (opts: { repo: string; prompt?: string; ticket?: string; model?: string }) => {
      const r = await getCore().queue.requestAdhoc({
        repository: opts.repo,
        prompt: opts.prompt,
        ticket: opts.ticket,
        model: opts.model,
      });
      if (!r.ok) return fail(r.error, { unknownRepoOutcome: 'No Run was queued.' });
      queued(r.value.run);
      if (r.value.warning !== undefined) io.err(`Warning: ${r.value.warning}`);
    });

  program
    .command('run-now')
    .description('Queue a manual Run for an Automation')
    .argument('<watchId>', 'Automation ID', idArg)
    .option('--instructions <text>', 'extra instructions for this Run')
    .option('--review-unresolved', 'also review existing unresolved discussions')
    .action((id: number, opts: { instructions?: string; reviewUnresolved?: boolean }) => {
      const r = getCore().watches.runNow(id, {
        extraInstructions: opts.instructions,
        reviewUnresolved: opts.reviewUnresolved,
      });
      if (!r.ok) return fail(r.error, { watchId: id });
      queued(r.value);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) {
      return e.code === 'commander.helpDisplayed' || e.code === 'commander.version' ? 0 : USAGE_ERROR;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return DOMAIN_ERROR;
  } finally {
    owned?.close();
  }
}
