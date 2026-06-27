import { test, expect } from '@playwright/test';

test('task modal autofocuses its title and closes on Escape', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await page.locator('.canvas-actions .btn-primary').click();

  const title = page.locator('.editor-title');
  await expect(title).toBeVisible();
  await expect(title).toBeFocused(); // autoFocus respected, not stolen by the trap

  await page.keyboard.press('Escape');
  await expect(page.locator('.editor-panel')).toHaveCount(0);
});

test('completed task can be toggled via keyboard', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  const firstCard = page.locator('#pendingList .task-card').first();
  await expect(firstCard).toBeVisible();
  const check = firstCard.locator('.card-check');
  await check.focus();
  await expect(check).toHaveAttribute('role', 'checkbox');
  await page.keyboard.press('Enter');
  // The toggled task leaves the pending column.
  await expect(page.locator('#doneList .task-card').first()).toBeVisible();
});
