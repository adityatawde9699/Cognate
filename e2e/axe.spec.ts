import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Automated WCAG 2 A/AA scan of the main surfaces. Serious and critical
// violations fail the build; the rest are reported in the failure message.
async function scan(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = blocking.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `${label}: ${summary.join('\n')}`).toEqual([]);
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('Plan has no serious accessibility violations', async ({ page }) => {
  await page.locator('.nav-btn', { hasText: 'Plan' }).click();
  await scan(page, 'Plan');
});
test('Dashboard has no serious accessibility violations', async ({ page }) => {
  await page.locator('.nav-btn', { hasText: 'Dashboard' }).click();
  await scan(page, 'Dashboard');
});
test('Tasks board has no serious accessibility violations', async ({ page }) => {
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await scan(page, 'Tasks');
});
test('Task editor has no serious accessibility violations', async ({ page }) => {
  await page.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await page.locator('.canvas-actions .btn-primary').click();
  await expect(page.locator('.editor-title')).toBeVisible();
  await scan(page, 'Task editor');
});
test('Settings has no serious accessibility violations', async ({ page }) => {
  await page.locator('.dock-link', { hasText: 'Settings' }).click();
  await expect(page.getByRole('dialog').or(page.locator('.settings-panel, .editor-panel')).first()).toBeVisible();
  await scan(page, 'Settings');
});
