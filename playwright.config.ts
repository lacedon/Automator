import { defineConfig, devices } from '@playwright/test';
import globalSetup from './test/e2e/global-setup';

// Playwright starts webServer before globalSetup, so the data is seeded here, while the config loads.
// Workers load this file too; the env flag (inherited by them) keeps them from wiping the running server's data.
process.env.AUTOMATOR_E2E_CONFIG ??= globalSetup();

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4399', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx next start -H 127.0.0.1 -p 4399',
    url: 'http://127.0.0.1:4399',
    env: { AUTOMATOR_CONFIG: process.env.AUTOMATOR_E2E_CONFIG },
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
