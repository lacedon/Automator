import { expect, test } from '@playwright/test';
import { bootstrap, createTelegramBot } from '../../src/core/index';

// The e2e config does not configure Telegram, so the worker must not start the bot (no token, no network).
test('the Telegram bot stays off when it is not configured', () => {
  const core = bootstrap({ configPath: process.env.AUTOMATOR_E2E_CONFIG! });
  try {
    expect(core.config.telegram).toBeUndefined();
    const bot = createTelegramBot({
      config: core.config,
      db: core.db,
      services: {
        clock: core.deps.clock,
        users: core.users,
        access: core.access,
        read: core.read,
        watches: core.watches,
        queue: core.queue,
        projects: core.projects,
      },
      log: () => {},
    });
    expect(bot).toBeNull();
  } finally {
    core.close();
  }
});
