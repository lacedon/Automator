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
