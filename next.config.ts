import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    // The config file path is resolved at runtime (AUTOMATOR_CONFIG / cwd); the app runs from the repo, so
    // whole-project file tracing is harmless.
    ignoreIssue: [{ path: /src\/core\/(config\/load|index)\.ts$/, title: /Dynamic filesystem access/ }],
  },
};

export default nextConfig;
