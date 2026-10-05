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
    await expect(page.getByRole('button', { name: 'Scan for suspected duplicates' })).toBeVisible();
    await expect(page.locator('.error-screen')).toHaveCount(0);
  });

  test('navigating to Tasks renders the board with seeded tasks', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
    await expect(page.locator('.board')).toBeVisible();
    await expect(page.locator('.task-card').first()).toBeVisible();
  });
});

test('matching tasks survive startup, duplicate review, and reload', async ({ page }) => {
  const tasks = ['repeat-a', 'repeat-b'].map((id, i) => ({
    id, title: 'Intentional matching work', description: 'Keep both copies', tags: [],
    deadline: '', importance: 3, effort: 3, done: false, priority: 'medium',
    created_at: '2026-01-01T10:00:00Z', sort_order: i,
  }));
  await page.addInitScript((rows) => {
    if (!localStorage.getItem('cn_tasks_v2')) {
      localStorage.setItem('cn_tasks_v2', JSON.stringify(rows));
    }
  }, tasks);
  await page.goto('/');
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await expect(page.locator('.task-card', { hasText: 'Intentional matching work' })).toHaveCount(2);
  await page.locator('.dock-link', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Scan for suspected duplicates' }).click();
  await expect(page.locator('#housekeeping').getByRole('status')).toContainText('1 suspected duplicate group. All tasks preserved.');
  await expect(page.getByText('Task IDs: repeat-a, repeat-b')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cn_tasks_v2'))).toBe(JSON.stringify(tasks));
  await page.reload();
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await expect(page.locator('.task-card', { hasText: 'Intentional matching work' })).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem('cn_tasks_v2'))).toBe(JSON.stringify(tasks));
});
