import { expect, test } from '@playwright/test';

// Tests share one seeded data dir and run in file order; the home test resumes the only Needs you Watch,
// so the Watches list test that expects it pinned first runs before it.

test('watches list pins needs-you first and shows jira notice', async ({ page }) => {
  await page.goto('/watches');
  await expect(page.getByText('Jira checking is off')).toBeVisible();
  const firstRow = page.locator('table tbody tr').first();
  await expect(firstRow).toHaveClass(/needs-row/);
  await expect(firstRow).toContainText('!42 Add retry to export job');
  await expect(page.locator('table tbody tr.needs-row')).toHaveCount(1);
});

test('home shows needs-you card and resume moves it away', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.card-needs', { hasText: '!42 Add retry to export job' });
  await expect(card).toContainText('Validation failed: npm test');
  await card.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
});

test('create form shows unknown repository error with result file path', async ({ page }) => {
  await page.goto('/watches/new');
  await page.getByLabel('Target URL or Jira key').fill('https://wiki.example.com/handbook');
  await page.getByLabel('Extra instructions').fill('Keep the handbook in sync.');
  await page.locator('#wf-repository').evaluate((select: HTMLSelectElement) => {
    select.add(new Option('nope', 'nope'));
    select.value = 'nope';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Create Watch' }).click();
  const box = page.locator('.error-box');
  await expect(box).toContainText('Unknown Repository "nope"');
  await expect(box).toContainText('No Watch was created');
  await expect(box).toContainText(/Result file: \S*e2e\/attempts\/\S+\.json/);
  await expect(page).toHaveURL(/\/watches\/new$/);
});

test('create form shows duplicate error with link to existing watch', async ({ page }) => {
  await page.goto('/watches/new');
  await page.getByLabel('Target URL or Jira key').fill('https://wiki.example.com/release');
  await page.getByLabel('Extra instructions').fill('Sync release notes into docs/.');
  await page.getByRole('button', { name: 'Create Watch' }).click();
  const box = page.locator('.error-box');
  await expect(box).toContainText('Already watched');
  await box.getByRole('link', { name: 'Open existing Watch →' }).click();
  await expect(page).toHaveURL(/\/watches\/\d+$/);
  await expect(page.getByText('docs-sync — wiki.example.com/release').first()).toBeVisible();
});

test('run detail shows transcript, result json and prompt tabs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Replied to 2 comments, pushed fix/ }).click();
  await expect(page).toHaveURL(/\/runs\/\d+$/);
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('# Transcript of Run #');
  await expect(panel).toContainText('Replied to 2 comments, pushed fix');
  await page.getByRole('tab', { name: 'Result JSON' }).click();
  await expect(panel).toContainText('"outcome": "acted"');
  await page.getByRole('tab', { name: 'Prompt' }).click();
  await expect(panel).toContainText('# Prompt for Run #');
});
