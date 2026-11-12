import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const SCRIPT_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 100_000;
const ERROR_TAIL_CHARS = 500;

const word = (names: string) => new RegExp(`(?<![\\w./-])(?:${names})(?![\\w-])`, 'i');

// A static first line of defence; the reviewer agent and the restricted environment are the others.
const DENIED: { rule: RegExp; message: string }[] = [
  {
    rule: word(
      'rm|rmdir|mv|cp|dd|tee|touch|mkdir|mktemp|mkfifo|ln|chmod|chown|chgrp|truncate|shred|install|unlink|rsync|scp|sftp|ftp',
    ),
    message: 'writes or deletes files',
  },
  {
    rule: /\bsed\s+(?:-[a-z]*i|--in-place)|\bperl\s+-[a-z]*i|\bfind\b[^\n]*\s-(?:delete|exec|execdir|fprint\w*)/i,
    message: 'edits or deletes files in place',
  },
  {
    rule: /curl\b[^\n]*\s(?:-X\s*(?!GET\b|HEAD\b)\w|--request\s+(?!GET\b|HEAD\b)\w)/i,
    message: 'uses a non-GET HTTP method',
  },
  {
    rule: /curl\b[^\n]*\s(?:-[A-Za-z]*[dFT]\b|--(?:data|data-\w+|form|form-string|upload-file|json|post301|post302|post303)\b)/i,
    message: 'sends data (POST/PUT) over HTTP',
  },
  {
    rule: /curl\b[^\n]*\s(?:-[A-Za-z]*L[A-Za-z]*\b|--location(?:-trusted)?\b|--max-redirs\b)/i,
    message: 'follows redirects',
  },
  {
    rule: /curl\b[^\n]*\s(?:-[A-Za-z]*[oOKcJ]\b|--(?:output|output-dir|remote-name|remote-name-all|remote-header-name|config|create-dirs|cookie-jar|trace|trace-ascii|trace-time|stderr|dump-header|libcurl|hsts|alt-svc|etag-save|netrc-file)\b)/,
    message: 'writes curl output to a file or reads a curl config',
  },
  { rule: /\bsort\b[^\n]*\s(?:-[A-Za-z]*o|--output\b)/, message: 'writes sort output to a file' },
  { rule: /\b(?!https?:)[a-z][a-z0-9+.-]*:\/\//i, message: 'uses a URL scheme other than http(s)' },
  { rule: word('wget|nc|ncat|netcat|telnet|ssh|socat'), message: 'uses a network tool other than plain curl GET' },
  {
    rule: word('eval|source|exec|sudo|su|xargs|nohup|crontab|bash|sh|zsh|dash|ksh|fish|osascript'),
    message: 'runs dynamic or elevated code',
  },
  {
    rule: word('python3?|node|perl|ruby|php|lua|deno|bun'),
    message: 'uses a scripting interpreter instead of plain shell tools',
  },
  {
    rule: word('git|gh|glab|npm|npx|pnpm|yarn|pip3?|brew|apt|apt-get|docker|kubectl|make'),
    message: 'uses a tool that can change state or read stored credentials',
  },
  {
    rule: word('copilot|claude|codex|opencode|gemini|openai|anthropic|ollama|aider|llm'),
    message: 'uses AI',
  },
  {
    rule: /(?:openai|anthropic|generativelanguage\.googleapis)\.com|api\.githubcopilot/i,
    message: 'calls an AI service',
  },
  { rule: word('env|printenv|export|declare'), message: 'reads or changes the environment' },
  {
    rule: /\$\{?\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH)\w*|authorization|\.netrc|\.env\b|\.ssh|\.aws|id_rsa|credentials|(?:^|[\s"'])-u\s|--user\b|--netrc|keychain/i,
    message: 'touches credentials',
  },
  { rule: /(?:^|[\s"'=(<:])~|\$\{?HOME\b|\bcd\b|\bpushd\b|\bpopd\b|\.\./i, message: 'leaves the working folder' },
  { rule: /(?:^|[\s"'=(<:])\/(?!dev\/null\b)/, message: 'uses an absolute path' },
  { rule: />/, message: 'redirects output to a file' },
];

// Output redirection that cannot write a file is allowed.
const HARMLESS_REDIRECTS = /(?:&|\d*)>+\s*\/dev\/null|\d*>&\d/g;

function stripNoise(script: string): string {
  return script
    .split('\n')
    .filter((line, i) => !(i === 0 && line.startsWith('#!')) && !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\bhttps?:\/\/[^\s"'`)|;&<>]+/gi, 'URL')
    .replace(HARMLESS_REDIRECTS, ' ');
}

export function denyListViolations(script: string): string[] {
  const text = stripNoise(script);
  return DENIED.filter(({ rule }) => rule.test(text)).map(({ message }) => message);
}

export type ScriptRunResult = { ok: true; output: string } | { ok: false; message: string };

const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];

// Runs in its own folder with a minimal environment: no credentials, no HOME outside the folder.
export function runPrecheckScript(
  script: string,
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ScriptRunResult> {
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const source = options.env ?? process.env;
  const env = { HOME: cwd } as Record<string, string> as NodeJS.ProcessEnv;
  for (const name of PASSED_ENV) {
    const value = source[name] ?? source[name.toLowerCase()];
    if (value !== undefined) (env as Record<string, string>)[name] = value;
  }
  fs.mkdirSync(cwd, { recursive: true });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: ScriptRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn('bash', ['-c', script], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-ERROR_TAIL_CHARS);
    });
    child.once('error', (error) => finish({ ok: false, message: `Cannot start the script: ${error.message}` }));
    child.once('close', (code, signal) => {
      if (timedOut) return finish({ ok: false, message: `Timed out after ${Math.round(timeoutMs / 60_000)} min` });
      if (code === 0) return finish({ ok: true, output: stdout.slice(0, MAX_OUTPUT_CHARS).trim() });
      finish({
        ok: false,
        message: `Exited with ${code === null ? `signal ${signal}` : `code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      });
    });
  });
}
