import fs from 'node:fs';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { bootstrap, formatDuration, intervalFor, parseDuration, type AppError, type Core, type Run, type WatchState } from '@core/index';

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
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
        error.attemptFile === null ? `Result file could not be written: ${error.attemptFileError}` : `Result file: ${error.attemptFile}`;
      return `Unknown Repository "${error.name}". ${ctx.unknownRepoOutcome} Known: ${error.known.join(', ')}. ${file}`;
    }
    case 'DUPLICATE_WATCH':
      return `Already watched: Watch #${error.existing.id} (${error.existing.state}, every ${formatDuration(error.existing.intervalMs)})`;
    case 'RUN_IN_PROGRESS':
      return 'Cancel the running Run first';
    case 'INVALID_TARGET':
    case 'INVALID_INPUT':
      return error.message;
    case 'MISSING_INSTRUCTIONS':
      return 'Free-form Watches need --instructions';
    case 'INVALID_STATE':
      return `Watch #${ctx.watchId} is ${error.state}; cannot ${error.action}`;
    case 'JIRA_DISABLED':
      return 'Jira checking is disabled (jira.enabled is false)';
    case 'NOT_FOUND':
      return `Watch #${ctx.watchId} not found`;
  }
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
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
    .description('Manage Automator Watches and Runs')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  const watch = program.command('watch').description('Manage Watches');

  watch
    .command('add <target>')
    .description('Create a Watch for an MR, Jira ticket or other URL')
    .requiredOption('--repo <name>', 'Repository name from the config')
    .option('--interval <duration>', 'check interval, e.g. 30m', durationArg)
    .option('--model <model>', 'Copilot model')
    .option('--instructions <text|@file>', 'instructions (required for free-form Watches)', textOrFileArg)
    .addOption(new Option('--initial-review <mode>', 'how existing comments are handled').choices(['baseline-only', 'unresolved']))
    .action((target: string, opts: { repo: string; interval?: number; model?: string; instructions?: string; initialReview?: 'baseline-only' | 'unresolved' }) => {
      const r = getCore().watches.create({
        target,
        repository: opts.repo,
        intervalMs: opts.interval,
        model: opts.model,
        instructions: opts.instructions,
        initialReview: opts.initialReview,
      });
      if (!r.ok) return fail(r.error, { unknownRepoOutcome: 'No Watch was created.' });
      io.out(`Watch #${r.value.id} created (${r.value.kind}, ${r.value.repository})`);
    });

  watch
    .command('list')
    .description('List Watches')
    .addOption(new Option('--state <state>', 'only Watches in this state').choices(WATCH_STATES))
    .option('--repo <name>', 'only Watches for this Repository')
    .action((opts: { state?: WatchState; repo?: string }) => {
      const { watches, config } = getCore();
      const rows = watches
        .list({ state: opts.state, repository: opts.repo })
        .map((w) => [String(w.id), w.state, w.kind, w.repository, formatDuration(intervalFor(w, config)), w.targetUrl]);
      for (const line of table([['ID', 'STATE', 'KIND', 'REPOSITORY', 'EVERY', 'TARGET'], ...rows])) io.out(line);
    });

  watch
    .command('rm')
    .description('Delete a Watch and its Runs')
    .argument('<id>', 'Watch ID', idArg)
    .action((id: number) => {
      const r = getCore().watches.delete(id);
      if (!r.ok) return fail(r.error, { watchId: id });
      io.out(`Watch #${id} deleted`);
    });

  program
    .command('run')
    .description('Queue an ad-hoc Run')
    .requiredOption('--repo <name>', 'Repository name from the config')
    .requiredOption('--prompt <text|@file>', 'prompt for Copilot', textOrFileArg)
    .option('--model <model>', 'Copilot model')
    .action((opts: { repo: string; prompt: string; model?: string }) => {
      const r = getCore().queue.enqueueAdhocChecked({ repository: opts.repo, prompt: opts.prompt, model: opts.model });
      if (!r.ok) return fail(r.error, { unknownRepoOutcome: 'No Run was queued.' });
      queued(r.value);
    });

  program
    .command('run-now')
    .description('Queue a manual Run for a Watch')
    .argument('<watchId>', 'Watch ID', idArg)
    .option('--instructions <text>', 'extra instructions for this Run')
    .option('--review-unresolved', 'also review existing unresolved discussions')
    .action((id: number, opts: { instructions?: string; reviewUnresolved?: boolean }) => {
      const r = getCore().watches.runNow(id, { extraInstructions: opts.instructions, reviewUnresolved: opts.reviewUnresolved });
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
