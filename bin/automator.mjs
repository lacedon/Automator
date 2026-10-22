#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

// Point tsx at the project tsconfig so the @core path alias resolves from any working directory.
register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });

const { runCli } = await import('../src/cli/main.ts');
const code = await runCli(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) });
// Exit only after stdout has flushed; pipes are asynchronous on macOS.
process.stdout.write('', () => process.exit(code));
