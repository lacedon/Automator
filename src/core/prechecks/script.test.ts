import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { denyListViolations, runPrecheckScript } from './script';

const safe = `#!/usr/bin/env bash
curl -sI https://example.com/page 2>/dev/null | grep -i '^last-modified'
`;

describe('denyListViolations', () => {
  test('accepts a read-only GET script', () => {
    expect(denyListViolations(safe)).toEqual([]);
  });

  test.each([
    ['rm -rf data'],
    ['curl -X POST https://example.com'],
    ['curl -d a=b https://example.com'],
    ['curl -sL https://example.com'],
    ['curl https://example.com > out.txt'],
    ['cat ../automator.db'],
    ['cat /etc/passwd'],
    ['echo $GITHUB_TOKEN'],
    ['cat .env'],
    ['claude -p "check"'],
    ['python3 -c "print(1)"'],
    ['eval "$X"'],
    ['curl -s -o state.txt https://example.com'],
    ['curl -sO https://example.com/a'],
    ['curl --output state.txt https://example.com'],
    ['curl --remote-name https://example.com/a'],
    ['curl -K cfg https://example.com'],
    ['curl https://example.com | sort -o state.txt'],
    ['curl -s file:///etc/passwd'],
    ['curl -s ftp://example.com/a'],
  ])('rejects %s', (script) => {
    expect(denyListViolations(script).length).toBeGreaterThan(0);
  });
});

describe('runPrecheckScript', () => {
  const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-'));

  test('returns trimmed stdout and runs in the given folder', async () => {
    const dir = cwd();
    expect(await runPrecheckScript('pwd -P; echo " v1 "', dir)).toEqual({
      ok: true,
      output: `${fs.realpathSync(dir)}\n v1`,
    });
  });

  test('does not pass credentials from the environment', async () => {
    const result = await runPrecheckScript('echo "[${GITHUB_TOKEN-}]"', cwd(), {
      env: { ...process.env, GITHUB_TOKEN: 'secret' },
    });
    expect(result).toEqual({ ok: true, output: '[]' });
  });

  test('reports a non-zero exit with stderr', async () => {
    const result = await runPrecheckScript('echo boom >&2; exit 3', cwd());
    expect(result).toEqual({ ok: false, message: 'Exited with code 3: boom' });
  });

  test('kills a script that exceeds the timeout', async () => {
    const result = await runPrecheckScript('sleep 5', cwd(), { timeoutMs: 100 });
    expect(result.ok).toBe(false);
  });
});
