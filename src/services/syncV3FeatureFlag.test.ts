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

    it('Item 1h: legacy cleanup stays hidden unless relay advertises capability AND room has matching token hash', async () => {
      const { LiveSyncSettings } = await import('../components/Settings/LiveSyncSettings');
      const React = (await import('react')).default;
      const ReactDOMServer = (await import('react-dom/server')).default;

      await setSyncV3Enabled(true);
      mem.setItem('sync_relay_url', 'https://relay.example');
      mem.setItem('sync_passphrase', 'correct horse battery staple');
      mem.setItem('sync_version', '3');
      mem.setItem('sync_delete_token', 'my-delete-token');
      mem.setItem('sync_workspace_binding', JSON.stringify({
        version: 3,
        url: 'https://relay.example',
        room: 'v3-room',
        v2_fallback: { room: 'v2-room' },
      }));

      // Case 1: Relay does NOT advertise capability (delete_supported = false)
      mem.setItem('test_relay_capabilities', JSON.stringify({ delete_supported: false }));
      mem.setItem('test_room_claimed_by_me', 'true');
      let html = ReactDOMServer.renderToString(React.createElement(LiveSyncSettings));
      expect(html).not.toContain('Legacy Relay Cleanup');

      // Case 2: Relay advertises capability, but room has NO registered matching hash
      mem.setItem('test_relay_capabilities', JSON.stringify({ delete_supported: true }));
      mem.setItem('test_room_claimed_by_me', 'false');
      html = ReactDOMServer.renderToString(React.createElement(LiveSyncSettings));
      expect(html).not.toContain('Legacy Relay Cleanup');

      // Case 3: Both conditions met (relay advertises delete AND room has matching token hash)
      mem.setItem('test_room_claimed_by_me', 'true');
      html = ReactDOMServer.renderToString(React.createElement(LiveSyncSettings));
      expect(html).toContain('Legacy Relay Cleanup');

      // Case 4: Another party controls the room -> delete UI hidden, hostile control warning shown
      mem.setItem('test_another_party_controls', 'true');
      html = ReactDOMServer.renderToString(React.createElement(LiveSyncSettings));
      expect(html).not.toContain('Legacy Relay Cleanup');
      expect(html).toContain('Another party controls this room. Treat its history as exposed.');
    });
  });
});
