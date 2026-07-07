import { test, expect } from '@playwright/test';

/**
 * The wedge: open the app → Auto-plan → the day lays itself out as time blocks.
 * Runs the browser fallback scheduler (planLocally) end-to-end: solve → persist
 * → render.
 */
test('Auto-plan lays out the day from the backlog', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();

  // Seeded open tasks start life in the backlog.
  await expect(page.locator('.plan-backlog-item').first()).toBeVisible();

  await page.locator('.plan-autoplan').click();

  // Tasks become scheduled time blocks on the timeline, with rationale.
  await expect(page.locator('.plan-block').first()).toBeVisible();
  await expect(page.locator('.plan-block-why').first()).toBeVisible();
});

test('a busy block is added and the day still plans around it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();

  // Answer the three prompts (title / start / end) by their message.
  page.on('dialog', (d) => {
    const msg = d.message();
    if (/Busy with what/i.test(msg)) return d.accept('Morning meeting');
    if (/Start time/i.test(msg)) return d.accept('09:00');
    if (/End time/i.test(msg)) return d.accept('10:00');
    return d.accept('');
  });
  await page.getByRole('button', { name: 'Busy time' }).click();

  await expect(page.locator('.plan-busy')).toContainText('Morning meeting');

  await page.locator('.plan-autoplan').click();
  await expect(page.locator('.plan-block').first()).toBeVisible();
});

test('a planned block can be marked done from the Plan view', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();
  await page.locator('.plan-autoplan').click();

  const block = page.locator('.plan-block').first();
  await expect(block).toBeVisible();
  await block.locator('.plan-check').click();
  await expect(block).toHaveClass(/is-done/);
});

test('dragging a block reschedules and pins it, then re-solves the rest', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();
  await page.locator('.plan-autoplan').click();

  const block = page.locator('.plan-block').first();
  await expect(block).toBeVisible();
  const grip = block.locator('.plan-grip');
  const box = await grip.boundingBox();
  if (!box) throw new Error('no grip box');

  // Drag the grip to the next block's position using Playwright's dragTo
  const target = page.locator('.plan-block').nth(1);
  await grip.dragTo(target);

  // The drag pins the block (and re-plans around it). Allow a longer timeout.
  await expect(page.locator('.plan-block .plan-pin.is-pinned').first(), { timeout: 10000 }).toBeVisible();
});

test('pasting .ics text imports calendar events the planner avoids', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();

  // Build an .ics whose event is on the date the Plan view is showing (today).
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'SUMMARY:Imported standup',
    `DTSTART:${ymd}T090000`,
    `DTEND:${ymd}T093000`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');

  page.on('dialog', (dlg) => dlg.accept(ics));
  await page.getByRole('button', { name: 'Sync calendar' }).click();

  await expect(page.locator('.plan-busy')).toContainText('Imported standup');

  await page.locator('.plan-autoplan').click();
  await expect(page.locator('.plan-block').first()).toBeVisible();
});
