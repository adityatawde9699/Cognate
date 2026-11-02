import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSyncV3Enabled,
  setSyncV3Enabled,
} from './relayService';
import {
  createWorkspaceGenesis,
  joinWorkspaceV3,
  migrateV2ToV3,
} from './migrationService';
import { _resetForTests as resetIdentity } from './identity';
import { _resetForTests as resetOplog } from './oplogStore';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

describe('Item 7: Feature Flag syncV3Enabled', () => {
  let mem: MemStorage;

  beforeEach(() => {
    mem = new MemStorage();
    (globalThis as any).localStorage = mem;
    resetIdentity();
    resetOplog();
  });

  it('syncV3Enabled defaults to false', async () => {
    const enabled = await isSyncV3Enabled();
    expect(enabled).toBe(false);
  });

  it('when syncV3Enabled is false, createWorkspaceGenesis is rejected', async () => {
    await setSyncV3Enabled(false);
    await expect(
      createWorkspaceGenesis('https://relay.example', 'correct horse battery staple')
    ).rejects.toThrow(/syncV3Enabled/);
  });

  it('when syncV3Enabled is false, joinWorkspaceV3 is rejected', async () => {
    await setSyncV3Enabled(false);
    await expect(
      joinWorkspaceV3('https://relay.example', 'correct horse battery staple', '0410-6105-0R3G-G28A-1C60-T3GF-20E')
    ).rejects.toThrow(/syncV3Enabled/);
  });

  it('when syncV3Enabled is false, migrateV2ToV3 is rejected', async () => {
    await setSyncV3Enabled(false);
    await expect(
      migrateV2ToV3('correct horse battery staple')
    ).rejects.toThrow(/syncV3Enabled/);
  });

  it('when syncV3Enabled is true, isSyncV3Enabled returns true', async () => {
    await setSyncV3Enabled(true);
    expect(await isSyncV3Enabled()).toBe(true);
  });

  describe('LiveSyncSettings UI flag states', () => {
    it('with syncV3Enabled=false: hides v3 create/join/migrate/cleanup and preserves v2 UI', async () => {
      const { LiveSyncSettings } = await import('../components/Settings/LiveSyncSettings');
      const React = (await import('react')).default;
      const ReactDOMServer = (await import('react-dom/server')).default;

      await setSyncV3Enabled(false);
      const html = ReactDOMServer.renderToString(React.createElement(LiveSyncSettings));

      expect(html).not.toContain('Create Workspace (v3)');
      expect(html).not.toContain('Join Existing (v3)');
      expect(html).not.toContain('Upgrade to Sync v3');
      expect(html).not.toContain('Legacy Relay Cleanup');
      expect(html).toContain('Connect to Relay');
      expect(html).toContain('Advanced');
      expect(html).toContain('Enable Sync Protocol v3 (Experimental)');
    });

    it('with syncV3Enabled=true: exposes v3 create/join/legacy tabs in the interface', async () => {
      const { LiveSyncSettings } = await import('../components/Settings/LiveSyncSettings');
      const React = (await import('react')).default;
      const ReactDOMServer = (await import('react-dom/server')).default;

      await setSyncV3Enabled(true);
      const html = ReactDOMServer.renderToString(React.createElement(LiveSyncSettings));

      expect(html).toContain('Create Workspace (v3)');
      expect(html).toContain('Join Existing (v3)');
      expect(html).toContain('Connect Legacy (v2)');
    });
  });
});
