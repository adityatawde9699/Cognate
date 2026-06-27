/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/recoveryService.ts — encrypted key escrow / recovery (Act 3)
   ──────────────────────────────────────────────────────
   Share secrets and the relay passphrase live only in this device's keychain.
   Lose the device and you lose access — so this exports a "recovery kit": all
   of those capabilities, sealed (AES-GCM) under a user-chosen RECOVERY
   passphrase. The kit is ciphertext — safe to store in a password manager or
   print — and useless without the passphrase. Importing on a new device
   restores live sync + every shared project. The recovery passphrase is never
   stored; a wrong one simply fails to decrypt.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { deriveKey, seal, open, type SealedBlob } from './crypto';
import { listShares, getShare, importShareRecord, type ShareMeta } from './shareService';
import { getConfig, enableSync } from './relayService';

interface RecoveryKit {
  v: 1;
  exported_at: string;
  relay: { url: string; passphrase: string } | null;
  shares: Array<ShareMeta & { secret: string }>;
}

/** Seal all share secrets + the relay config under a recovery passphrase. */
export async function exportRecoveryKit(passphrase: string): Promise<string> {
  if (!passphrase.trim()) throw new Error('Choose a recovery passphrase.');
  const shares: Array<ShareMeta & { secret: string }> = [];
  for (const m of await listShares()) {
    const full = await getShare(m.id);
    if (full) shares.push(full);
  }
  const kit: RecoveryKit = {
    v: 1,
    exported_at: new Date().toISOString(),
    relay: await getConfig(),
    shares,
  };
  const key = await deriveKey(passphrase);
  return JSON.stringify(await seal(key, kit));
}

/** Restore a recovery kit: re-enable sync and re-add every shared project. */
export async function importRecoveryKit(json: string, passphrase: string): Promise<{ shares: number; relay: boolean }> {
  let blob: SealedBlob;
  try {
    blob = JSON.parse(json);
  } catch {
    throw new Error('That doesn’t look like a recovery kit.');
  }
  const key = await deriveKey(passphrase);
  const kit = await open<RecoveryKit>(key, blob); // throws on wrong passphrase / tampering
  if (!kit || kit.v !== 1 || !Array.isArray(kit.shares)) throw new Error('Unrecognized recovery kit.');

  if (kit.relay?.url) await enableSync(kit.relay.url, kit.relay.passphrase);
  for (const s of kit.shares) {
    const { secret, ...meta } = s;
    if (secret) await importShareRecord(meta, secret);
  }
  return { shares: kit.shares.length, relay: !!kit.relay?.url };
}
