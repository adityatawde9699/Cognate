import { test, expect } from '@playwright/test';

// Opt out of the default "already onboarded" storage state so the first-run
// overlay actually appears for this spec.
test.use({ storageState: { cookies: [], origins: [] } });

test('first run: the welcome appears and "Plan my day" lands on the Plan', async ({ page }) => {
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'Welcome to Cognate' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Your day, planned in 60 seconds')).toBeVisible();

  await page.getByRole('button', { name: /Plan my day/i }).click();

  // The overlay closes and the Plan view is shown.
  await expect(dialog).toBeHidden();
  await expect(page.locator('.plan-view')).toBeVisible();
});

test('first run can be skipped and does not return on reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Skip for now/i }).click();
  await expect(page.getByRole('dialog', { name: 'Welcome to Cognate' })).toBeHidden();

  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Welcome to Cognate' })).toBeHidden();
});
