import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * The Act 2 promise, end-to-end: a task created on "device A" travels to a
 * separate "device B" (its own storage) via an exported sync bundle, and the
 * merge reconciles into B's database + UI. No shared state, no server.
 */
test('a task syncs from one device to another through a bundle', async ({ browser }) => {
  // ── Device A: create a uniquely-named task, then export the bundle ──
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/');
  await expect(pageA.locator('.plan-view')).toBeVisible();

  const marker = `SyncProof-${Date.now()}`;
  await pageA.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await expect(pageA.locator('.board')).toBeVisible();
  await pageA.locator('.canvas-actions .btn-primary').click();
  await expect(pageA.locator('.editor-title')).toBeVisible();
  await pageA.locator('.editor-title').fill(marker);
  await pageA.locator('.editor-panel button[type="submit"]').click();
  await expect(pageA.locator('.task-card', { hasText: marker })).toBeVisible();

  await pageA.locator('.dock-link', { hasText: 'Settings' }).click();
  await pageA.locator('.tag-nav-btn', { hasText: 'Sync' }).click();
  const downloadPromise = pageA.waitForEvent('download');
  await pageA.getByRole('button', { name: 'Export sync bundle' }).click();
  const download = await downloadPromise;
  const bundle = await readFile(await download.path(), 'utf-8');
  expect(bundle).toContain(marker); // the op-log carries the task

  // ── Device B: fresh storage, import & merge the bundle ──
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/');
  await expect(pageB.locator('.plan-view')).toBeVisible();
  await expect(pageB.locator('.task-card', { hasText: marker })).toHaveCount(0); // not here yet

  await pageB.locator('.dock-link', { hasText: 'Settings' }).click();
  await pageB.locator('.tag-nav-btn', { hasText: 'Sync' }).click();
  pageB.once('filechooser', (fc) =>
    fc.setFiles({ name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(bundle) })
  );
  await pageB.getByRole('button', { name: 'Import & merge' }).click();

  // The merged task now exists on device B's board.
  await pageB.locator('.dock-link', { hasText: 'Settings' }).click().catch(() => {});
  await pageB.locator('.nav-btn', { hasText: 'Tasks' }).click();
  await expect(pageB.locator('.task-card', { hasText: marker })).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
