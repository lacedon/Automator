import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./app/lib/i18nRequest.ts');

const nextConfig: NextConfig = {
  agentRules: false,
  serverExternalPackages: ['better-sqlite3'],
  async redirects() {
    return [
      { source: '/watches', destination: '/automations', permanent: true },
      { source: '/watches/:path*', destination: '/automations/:path*', permanent: true },
    ];
  },
  turbopack: {
    // The config file path is resolved at runtime (AUTOMATOR_CONFIG / cwd); the app runs from the repo, so
    // whole-project file tracing is harmless.
    ignoreIssue: [{ path: /src\/core\/(config\/load|index)\.ts$/, title: /Dynamic filesystem access/ }],
  },
};

export default withNextIntl(nextConfig);
