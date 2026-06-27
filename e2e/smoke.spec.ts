import { test, expect } from '@playwright/test';

/**
 * Render smoke — the guard the invisible-editor episode demanded. If the app
 * boots to a blank or fatal screen, these fail loudly.
 */
test.describe('render smoke', () => {
  test('boots to a visible shell, not a blank or error screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.getByText('Workspace')).toBeVisible();
    // The React fatal-error screen must not be showing.
    await expect(page.locator('.error-screen')).toHaveCount(0);
    // The main canvas actually rendered something.
    await expect(page.locator('.main')).not.toBeEmpty();
  });

  test('default landing view is the Plan', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.plan-view')).toBeVisible();
    await expect(page.locator('.plan-autoplan')).toBeVisible();
  });

  test('opening Settings does not crash (no hook-order error)', async ({ page }) => {
    await page.goto('/');
    await page.locator('.dock-link', { hasText: 'Settings' }).click();
    await expect(page.locator('.side-panel.open')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove duplicate tasks' })).toBeVisible();
    await expect(page.locator('.error-screen')).toHaveCount(0);
  });

  test('navigating to Tasks renders the board with seeded tasks', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
    await expect(page.locator('.board')).toBeVisible();
    await expect(page.locator('.task-card').first()).toBeVisible();
  });
});
