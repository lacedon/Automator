import { expect, test } from '@playwright/test';

test('Home prioritizes current attention and previews the shared queue', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Validation failed: npm test');
  await expect(page.getByRole('link', { name: 'Review decision' })).toHaveAttribute('href', /\/watches\/\d+$/);
  const settings = await page
    .getByRole('navigation', { name: 'Main', exact: true })
    .getByRole('link', { name: 'Settings', exact: true })
    .boundingBox();
  expect(settings?.y).toBeGreaterThan(500);
  const queue = page.getByRole('region', { name: 'Up next' });
  await expect(queue).toContainText('Regenerate API types');
  await queue.getByRole('link', { name: 'Open queue' }).click();
  await expect(page).toHaveURL(/\/queue$/);
});

test('Chats search and filters retain context and link to real run details', async ({ page }) => {
  await page.goto('/runs');
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
  await page.getByLabel('Search runs').fill('Committed CHANGELOG entry');
  await page.getByLabel('Repository', { exact: true }).selectOption('pages');
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  await page.getByLabel('From date').fill(today);
  await page.getByLabel('To date').fill(today);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.locator('.run-history tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'Errors', exact: true }).click();
  await expect(page.getByLabel('Search runs')).toHaveValue('Committed CHANGELOG entry');
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('pages');
  await expect(page.getByLabel('From date')).toHaveValue(today);
  await expect(page.getByLabel('To date')).toHaveValue(today);
  await expect(page.getByText('No chats match these filters.')).toBeVisible();
  await page.getByRole('link', { name: 'All chats', exact: true }).click();
  await page
    .locator('.run-history')
    .getByRole('link', { name: /Update CHANGELOG for 4\.2/ })
    .click();
  await expect(page).toHaveURL(/\/runs\/\d+$/);
  await page.goto('/runs?from=2026-02-30');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter valid dates' })).toBeVisible();
  await page.goto('/runs?from=2026-11-05&to=2026-11-04');
  await expect(page.getByRole('alert').filter({ hasText: 'From must be on or before To' })).toBeVisible();
});

test('Projects remain manageable in Settings while the header scopes operational views', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/projects$/);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Project name').fill('Dashboard test');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project', exact: true }).click();
  const project = page.getByRole('row', { name: /^Dashboard test(\s|$)/ });
  await project.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    page.getByRole('dialog').locator('.settings-dialog-footer').getByRole('button', { name: 'Rename', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog').locator('.settings-dialog-footer').getByRole('button', { name: 'Save repositories' }),
  ).toBeVisible();
  await page.getByRole('dialog').getByLabel('pages', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Save repositories' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await project.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('pages', { exact: true })).toBeChecked();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('none');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeEnabled();
  await expect(project).toBeVisible();
  await page.goto('/settings/repositories');
  await expect(page.getByRole('row', { name: /^pages(\s|$)/ })).toContainText('Dashboard test');
  await page.goto('/');
  await expect(page.getByText('Nothing needs you.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing running.', { exact: true })).toBeVisible();
  await page.goto('/runs');
  await expect(page.getByText('No chats yet.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('all');
  await expect(page.locator('.run-history tbody tr')).not.toHaveCount(0);
  await page.goto('/settings/projects');
  await project.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Project name').fill('Renamed dashboard test');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  const renamed = page.getByRole('row', { name: /^Renamed dashboard test(\s|$)/ });
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Project name')).toHaveValue('Renamed dashboard test');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await renamed.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(renamed).toHaveCount(0);
});

test('Settings groups Projects and Repositories and preserves the legacy project link', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/settings\/projects$/);
  const mainNav = page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(mainNav.getByRole('link', { name: 'Projects', exact: true })).toHaveCount(0);
  await expect(mainNav.getByRole('link', { name: 'Repositories', exact: true })).toHaveCount(0);
  await expect(mainNav.getByRole('link', { name: 'Ad-hoc', exact: true })).toHaveCount(0);
  await expect(mainNav.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('link', { name: 'Repositories' })
    .click();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('main')).toContainText('pages');
  await page
    .getByRole('row', { name: /^pages/ })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByLabel('Local folder')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Save Repository' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: 'Open Configuration' }).click();
  await expect(page).toHaveURL(/\/settings\/config$/);
});

test('mobile navigation keeps actions accessible without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/runs');
  await expect(page.locator('.brand svg')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeHidden();
  for (const label of ['From date', 'To date']) {
    const dateField = await page.getByLabel(label).boundingBox();
    expect(dateField?.width).toBeGreaterThan(110);
    expect(dateField?.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator('.mobile-nav-trigger').click();
  await page.getByRole('navigation', { name: 'Main mobile' }).getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page).toHaveURL(/\/adhoc$/);
  await expect(page.locator('.mobile-nav')).not.toHaveAttribute('open');
  for (const route of ['/', '/runs', '/settings/projects', '/settings/repositories']) {
    await page.goto(route);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('New chat page is a chat window with prompt autocomplete and per-chat fields', async ({ page }) => {
  await page.goto('/adhoc');
  await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Message' }).or(page.locator('#ah-prompt'));
  await expect(prompt).toBeVisible();
  for (const label of ['Repository', 'Ticket (optional)', 'Agent', 'Model']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await prompt.fill('/mod');
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await prompt.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('Home no longer lists recently completed Runs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Recently completed')).toHaveCount(0);
});
