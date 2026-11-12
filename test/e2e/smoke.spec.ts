import { expect, test } from '@playwright/test';

// Tests share one seeded data dir and run in file order; the home test resumes the only Needs you Automation,
// so the Automations list test that expects it pinned first runs before it.

test('provider settings show the global selector and provider model fields', async ({ page }) => {
  await page.goto('/settings/config');
  await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
  const provider = page.getByLabel('Provider', { exact: true });
  await expect(provider).toHaveValue('copilot');
  await expect(provider.locator('option')).toHaveText([
    'GitHub Copilot CLI',
    'Claude Code',
    'OpenAI Codex CLI',
    'OpenCode',
  ]);
  for (const id of [
    'config-copilotBin',
    'config-runs-defaultModel',
    'config-providers-claude-code-bin',
    'config-providers-claude-code-defaultModel',
    'config-providers-claude-code-models',
    'config-providers-codex-bin',
    'config-providers-codex-defaultModel',
    'config-providers-codex-models',
    'config-providers-opencode-bin',
    'config-providers-opencode-defaultModel',
    'config-providers-opencode-models',
  ]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  await expect(page.locator('body')).not.toContainText(/(?:GITLAB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)/);
});

test('run list labels each run with its provider', async ({ page }) => {
  await page.goto('/watches/2');
  await expect(page.getByRole('columnheader', { name: 'Provider' })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toContainText('GitHub Copilot CLI');
});

test('watches list pins needs-you first and shows jira notice', async ({ page }) => {
  await page.goto('/automations');
  await expect(page.getByText('Jira checking is off')).toBeVisible();
  const firstRow = page.locator('table tbody tr').first();
  await expect(firstRow).toHaveClass(/needs-row/);
  await expect(firstRow).toContainText('!42 Add retry to export job');
  await expect(page.locator('table tbody tr.needs-row')).toHaveCount(1);
});

test('home opens the decision flow and resume moves the item away', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.card-needs', { hasText: '!42 Add retry to export job' });
  await expect(card).toContainText('Validation failed: npm test');
  await card.getByRole('link', { name: 'Review decision' }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.goto('/');
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
});

test('create form shows unknown repository error with result file path', async ({ page }) => {
  await page.goto('/automations/new');
  await page.getByLabel('Target URL or Jira key').fill('https://wiki.example.com/handbook');
  await page.getByLabel('Extra instructions').fill('Keep the handbook in sync.');
  await page.locator('#wf-repository').evaluate((select: HTMLSelectElement) => {
    select.add(new Option('nope', 'nope'));
    select.value = 'nope';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Create Automation' }).click();
  const box = page.locator('.error-box');
  await expect(box).toContainText('Unknown Repository "nope"');
  await expect(box).toContainText('No Automation was created');
  await expect(box).toContainText(/Result file: \S*e2e\/attempts\/\S+\.json/);
  await expect(page).toHaveURL(/\/automations\/new$/);
});

test('create form shows duplicate error with link to existing watch', async ({ page }) => {
  await page.goto('/automations/new');
  await page.getByLabel('Target URL or Jira key').fill('https://wiki.example.com/release');
  await page.getByLabel('Extra instructions').fill('Sync release notes into docs/.');
  await page.getByRole('button', { name: 'Create Automation' }).click();
  const box = page.locator('.error-box');
  await expect(box).toContainText('Already automated');
  await box.getByRole('link', { name: 'Open existing Automation →' }).click();
  await expect(page).toHaveURL(/\/automations\/\d+$/);
  await expect(page.getByText('docs-sync — wiki.example.com/release').first()).toBeVisible();
});

test('run detail is chat-first with file modals and collapsed details', async ({ page }) => {
  await page.goto('/automations');
  await page.getByRole('link', { name: '!51 Bump eslint config', exact: true }).click();
  await page.getByRole('link', { name: 'Replied to 2 comments, pushed fix' }).click();
  await expect(page).toHaveURL(/\/runs\/\d+$/);
  await expect(page.getByRole('tab')).toHaveCount(0);
  const details = page.locator('details.run-details');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(page.locator('.kv')).toBeHidden();
  await details.getByText('Run details', { exact: true }).click();
  await expect(page.locator('.kv')).toContainText('GitHub Copilot CLI');
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Transcript' }).click();
  await expect(dialog).toContainText('# Transcript of Run #');
  await expect(dialog).toContainText('Replied to 2 comments, pushed fix');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Result JSON' }).click();
  await expect(dialog).toContainText('"outcome": "acted"');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Prompt' }).click();
  await expect(dialog).toContainText('# Prompt for Run #');
});

test('run detail chat-first layout fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/automations');
  await page.getByRole('link', { name: '!51 Bump eslint config', exact: true }).click();
  await page.getByRole('link', { name: 'Replied to 2 comments, pushed fix' }).click();
  await expect(page.getByRole('button', { name: 'Transcript' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('run detail auto-refreshes only while the run is not finished', async ({ page }) => {
  const refreshes: string[] = [];
  page.on('request', (req) => {
    const headers = req.headers();
    if (
      headers['rsc'] === '1' &&
      headers['next-router-prefetch'] !== '1' &&
      new URL(req.url()).pathname === new URL(page.url()).pathname
    ) {
      refreshes.push(req.url());
    }
  });

  await page.goto('/queue');
  await page.getByRole('link', { name: /^run #\d+$/ }).click();
  await expect(page).toHaveURL(/\/runs\/\d+$/);
  refreshes.length = 0;
  await page.waitForTimeout(4000);
  expect(refreshes.length).toBeGreaterThan(0);

  await page.goto('/automations');
  await page.getByRole('link', { name: '!51 Bump eslint config', exact: true }).click();
  await page.getByRole('link', { name: 'Replied to 2 comments, pushed fix' }).click();
  await expect(page).toHaveURL(/\/runs\/\d+$/);
  refreshes.length = 0;
  await page.waitForTimeout(4000);
  expect(refreshes).toEqual([]);
});

test('ad-hoc run opens on the chat by default', async ({ page }) => {
  await page.goto('/runs');
  await page
    .locator('.run-history')
    .getByRole('link', { name: /Check <b>the<\/b> export job/ })
    .click();
  await expect(page).toHaveURL(/\/runs\/(\d+)$/);
  await expect(page.locator('.chat .chat-request')).toHaveText('Check <b>the</b> export job');
});

// Runs last: replying queues a follow-up Run, which would add a row to the Queue page the tests above rely on.
test('ad-hoc chat: reply queues a follow-up Run', async ({ page }) => {
  await page.goto('/runs');
  await page
    .locator('.run-history')
    .getByRole('link', { name: /Check <b>the<\/b> export job/ })
    .click();
  await expect(page).toHaveURL(/\/runs\/\d+$/);
  const panel = page.locator('.chat');
  await expect(panel.locator('.chat-request')).toHaveText('Check <b>the</b> export job');
  await expect(panel.locator('b')).toHaveCount(0);
  await expect(panel.locator('.chat-agent')).toContainText('Which environment should the export job run against?');

  await panel.getByLabel('Message').fill('Use the staging URL');
  await panel.getByRole('button', { name: 'Send' }).click();

  const queued = panel.locator('.chat-run', { hasText: 'Use the staging URL' });
  await expect(queued).toContainText('queued');
  await expect(panel.getByLabel('Message')).toHaveCount(0);
  await expect(panel.getByText(/^Waiting for Run #\d+ to finish$/)).toBeVisible();
});

test('free-form form generates a pre-check script and keeps its instructions', async ({ page }) => {
  await page.goto('/automations/new');
  await expect(page.getByLabel('Pre-check instructions')).toHaveCount(0);
  await page.getByLabel('Target URL or Jira key').fill('https://wiki.example.com/precheck');
  await page.getByLabel('Extra instructions').fill('Summarize the page changes.');
  await page.getByLabel('Pre-check instructions').fill('Compare the Last-Modified header of the page.');
  await page.getByRole('button', { name: 'Create Automation' }).click();
  await expect(page).toHaveURL(/\/automations\/\d+$/);
  await expect(page.getByText('Compare the Last-Modified header of the page.')).toBeVisible();

  await page.getByRole('link', { name: 'Edit' }).first().click();
  await expect(page.getByLabel('Pre-check instructions')).toHaveValue('Compare the Last-Modified header of the page.');
});
