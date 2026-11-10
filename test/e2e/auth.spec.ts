import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('unauthenticated pages redirect to sign-in and keep the destination', async ({ page }) => {
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/login\?next=%2Fruns$/);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
});

test('a wrong password is rejected', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.error-box')).toContainText('Wrong username or password');
});

test('protected files and POSTs answer 401 without a session', async ({ request }) => {
  expect((await request.get('/files/run/1/transcript.txt')).status()).toBe(401);
  expect((await request.post('/runs', { headers: { 'next-action': 'x' } })).status()).toBe(401);
});

test('signing out ends the session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/queue');
  await expect(page).toHaveURL(/\/login\?next=%2Fqueue$/);
});

test('the Users & roles page manages users, roles and assignments', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.goto('/settings/access');
  await page.getByLabel('New username').fill('reviewer');
  await page.getByLabel('New password').fill('pw');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('table', { name: 'Users' })).toContainText('reviewer');
  await page.getByLabel('New role name').fill('Viewer');
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByRole('table', { name: 'Roles' })).toContainText('Viewer');
  await page.getByLabel('Assign user').selectOption({ label: 'reviewer' });
  await page.getByLabel('Assign role').selectOption({ label: 'Viewer' });
  await page.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByRole('table', { name: 'Assignments' })).toContainText('Viewer · All projects');
  await page
    .getByRole('row', { name: /admin Administrator/ })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.locator('.error-box')).toContainText('nobody able to manage');
});

test('an access token authenticates API requests until it is revoked', async ({ page, request }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.goto('/account');
  await page.getByLabel('Token name').fill('e2e');
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = (await page.locator('.token-secret code').innerText()).trim();

  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.get('/queue', { headers })).status()).toBe(200);
  expect((await request.get('/queue', { headers: { Authorization: 'Bearer atk_wrong' } })).status()).toBe(401);

  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Expires:')).toHaveCount(0);
  expect((await request.get('/queue', { headers })).status()).toBe(401);
});

test('a user stores a credential and it is never shown again', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.goto('/account');
  await page.getByLabel('Credential name').selectOption('GH_TOKEN');
  await page.getByLabel('Credential value').fill('ghp_e2e_secret');
  await page.getByRole('button', { name: 'Save credential' }).click();
  await expect(page.getByRole('row', { name: /GH_TOKEN/ })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('ghp_e2e_secret');
  await page
    .getByRole('row', { name: /GH_TOKEN/ })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByRole('row', { name: /GH_TOKEN/ })).toHaveCount(0);
});
