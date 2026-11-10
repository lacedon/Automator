import { expect, test as setup } from '@playwright/test';

// The seeded installation has the bootstrap admin:admin account.
setup('sign in as the bootstrap admin', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.context().storageState({ path: 'test-results/e2e-auth.json' });
});
