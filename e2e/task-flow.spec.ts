import { test, expect, Page } from '@playwright/test';

async function gotoBoard(page: Page) {
  await page.goto('/');
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await expect(page.locator('.board')).toBeVisible();
}

async function createTask(page: Page, title: string) {
  await page.locator('.canvas-actions .btn-primary').click();
  await expect(page.locator('.editor-title')).toBeVisible();
  await page.locator('.editor-title').fill(title);
  await page.locator('.editor-panel button[type="submit"]').click();
  await expect(page.locator('.task-card', { hasText: title })).toBeVisible();
}

test('create → complete → delete → restore round-trips through the UI', async ({ page }) => {
  const title = `E2E task ${Date.now()}`;
  await gotoBoard(page);
  await expect(page.locator('.task-card').first()).toBeVisible(); // seeded data present

  await createTask(page, title);

  // Complete it → moves to the Completed column.
  await page.locator('.task-card', { hasText: title }).locator('.card-check').click();
  await expect(page.locator('#doneList .task-card', { hasText: title })).toBeVisible();

  // Delete (soft) → disappears from the board.
  const doneCard = page.locator('#doneList .task-card', { hasText: title });
  await doneCard.hover();
  await doneCard.locator('.btn-del').click();
  await expect(page.locator('.task-card', { hasText: title })).toHaveCount(0);

  // It lives in Trash, recoverable.
  await page.locator('.dock-link', { hasText: 'Trash' }).click();
  const row = page.locator('.trash-row', { hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.trash-row', { hasText: title })).toHaveCount(0);
});

test('seed runs once: completing a task moves it without leaving a duplicate', async ({ page }) => {
  await gotoBoard(page);

  // No seeded title should appear more than once across the board (the
  // double-seed race inserted every demo task twice).
  const titles = await page.locator('.task-card .card-title').allInnerTexts();
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  expect(dupes, `duplicate seeded tasks: ${dupes.join(', ')}`).toEqual([]);

  // Completing the first pending task moves it to Done and leaves nothing behind.
  const first = page.locator('#pendingList .task-card').first();
  const title = (await first.locator('.card-title').innerText()).trim();
  await first.locator('.card-check').click();
  await expect(page.locator('#pendingList .task-card', { hasText: title })).toHaveCount(0);
  await expect(page.locator('#doneList .task-card', { hasText: title })).toHaveCount(1);
});

test('Ctrl+Z undoes a delete', async ({ page }) => {
  const title = `Undo task ${Date.now()}`;
  await gotoBoard(page);
  await createTask(page, title);

  const card = page.locator('.task-card', { hasText: title });
  await card.hover();
  await card.locator('.btn-del').click();
  await expect(page.locator('.task-card', { hasText: title })).toHaveCount(0);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.task-card', { hasText: title })).toBeVisible();
});
