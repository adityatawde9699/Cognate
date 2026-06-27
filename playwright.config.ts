import { defineConfig, devices } from '@playwright/test';

/**
 * e2e wall (Act 0). Drives the app in a real browser against Vite's dev server.
 * In the browser the app runs its localStorage fallback (IS_TAURI = false), so
 * these specs exercise the full UI + store + services stack headlessly in CI —
 * no Tauri runtime required. The render-smoke spec is the guard the
 * invisible-editor regression would have tripped.
 */
const PORT = 1420;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    // Most specs model an existing (already-onboarded) user, so the first-run
    // overlay doesn't intercept them. The onboarding spec opts out via test.use.
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${PORT}`, localStorage: [{ name: 'cn_set_onboarded', value: '1' }] }],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
