import { describe, it, expect } from 'vitest';
import { shouldRegisterSW } from './pwa';
// The manifest is imported as raw text via Vite so this stays type-clean.
import manifestRaw from '../../public/manifest.webmanifest?raw';

describe('pwa registration decision', () => {
  const base = { isTauri: false, hasServiceWorker: true, isProd: true };

  it('registers only on a production web build', () => {
    expect(shouldRegisterSW(base)).toBe(true);
  });
  it('never registers inside the Tauri desktop shell', () => {
    expect(shouldRegisterSW({ ...base, isTauri: true })).toBe(false);
  });
  it('skips when service workers are unavailable', () => {
    expect(shouldRegisterSW({ ...base, hasServiceWorker: false })).toBe(false);
  });
  it('skips in dev', () => {
    expect(shouldRegisterSW({ ...base, isProd: false })).toBe(false);
  });
});

describe('web app manifest', () => {
  it('is valid JSON with the fields needed for installability', () => {
    const m = JSON.parse(manifestRaw);
    expect(m.name).toBeTruthy();
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    // Must advertise a 192 and a 512 icon (the install-prompt minimum).
    const sizes = (m.icons as any[]).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect((m.icons as any[]).some((i) => String(i.purpose).includes('maskable'))).toBe(true);
  });
});
