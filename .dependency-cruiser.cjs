// @ts-check
// Boundary rules for Automator (adapted from .agents/skills/setup-ts-deep-modules).
// src/core is the deep module; entry points (app/, src/worker, src/cli) reach it only via src/core/index.ts.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-is-independent',
      comment: 'src/core must not depend on the dashboard, worker, CLI, Next.js or React.',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '^(app|src/worker|src/cli)|node_modules/(next|react)' },
    },
    {
      name: 'entrypoints-use-core-index',
      comment: 'app/, src/worker and src/cli import core only through src/core/index.ts (type-only imports excepted).',
      severity: 'error',
      from: { path: '^(app|src/worker|src/cli)' },
      to: { path: '^src/core/(?!index\\.ts$)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-circular',
      comment: 'No dependency cycles.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};
