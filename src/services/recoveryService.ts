/** Versioned encrypted recovery: signing identity, task/project snapshot,
 * history and relay/share capabilities. Restore onto an empty replacement
 * workspace; retire the old device to avoid cloning a live actor. */
import { sealPassword,openPassword,importPrivateKey,importPublicKey,signBytes,verifyBytes,type PasswordBlob,type SealedBlob } from './crypto';
import {listShares,getShare,importShareRecord,type ShareMeta} from './shareService';
import {getConfig,enableSync} from './relayService';
import {getIdentity,_resetForTests as resetIdentity} from './identity';
import {_resetForTests as resetClock} from './oplogStore';
import {getSetting,setSetting,IS_TAURI,commitProjection} from '../db';
import {getSecret,setSecret} from '../utils/secrets';
import {encryptBrowserSecret} from '../utils/browserVault';
import {captureHistoryAudit,normalizedTask,fingerprint,type HistoryAudit} from './historyAudit';
import {validateOps} from './oplog';
interface Capabilities {exported_at:string;relay:{url:string;passphrase:string}|null;shares:Array<ShareMeta & {secret:string}>}
interface RecoveryKit extends Capabilities {v:2;id:string;identity:{actor:string;pub:string;privateKey:string};snapshot:HistoryAudit['snapshot']}
interface LegacyKit extends Capabilities {v:1}
export async function exportRecoveryKit(passphrase:string):Promise<string> {
  const identity=await getIdentity();
  const shares:Array<ShareMeta & {secret:string}>=[];
  for(const meta of await listShares()) {const full=await getShare(meta.id);if(full)shares.push(full);}
  const kit:RecoveryKit={v:2,id:crypto.randomUUID(),exported_at:new Date().toISOString(),relay:await getConfig(),shares,
    identity:{actor:identity.actor,pub:identity.pub,privateKey:await getSecret('crdt_signing_key')},snapshot:(await captureHistoryAudit()).snapshot};
  return JSON.stringify(await sealPassword(passphrase,kit));
}
function validateCapabilities(kit:Capabilities) {
  if(!Array.isArray(kit.shares) || kit.shares.length>1000) throw new Error('Invalid recovery shares.');
  for(const share of kit.shares) {
    if(!share.id || !share.projectId || !share.genesis?.actor || !share.genesis.pub || typeof share.secret!=='string' || !['owner','editor','commenter','viewer'].includes(share.role)) throw new Error('Invalid recovered share.');
  }
  if(kit.relay && (typeof kit.relay.url!=='string' || typeof kit.relay.passphrase!=='string')) throw new Error('Invalid recovered relay configuration.');
}
export async function importRecoveryKit(json:string,passphrase:string):Promise<{shares:number;relay:boolean;identity:boolean}> {
  if(json.length>32*1024*1024) throw new Error('Recovery kit exceeds 32 MB.');
  let blob:PasswordBlob|SealedBlob;
  try{blob=JSON.parse(json);}catch{throw new Error('That does not look like a recovery kit.');}
  const kit=await openPassword<RecoveryKit|LegacyKit>(passphrase,blob);
  if(!kit || ![1,2].includes(kit.v)) throw new Error('Unrecognized recovery kit.');
  validateCapabilities(kit);
  if(kit.v===2) {
    validateOps(kit.snapshot.ops);
    if(!Array.isArray(kit.snapshot.tasks) || !Array.isArray(kit.snapshot.projects) || !kit.id || !kit.identity?.actor || !kit.identity.privateKey || !kit.identity.pub) throw new Error('Invalid identity recovery snapshot.');
    const privateKey=await importPrivateKey(kit.identity.privateKey),publicKey=await importPublicKey(kit.identity.pub);
    const challenge=crypto.getRandomValues(new Uint8Array(32));
    if(!await verifyBytes(publicKey,await signBytes(privateKey,challenge),challenge)) throw new Error('Recovery signing keys do not match.');
    if(await getSetting('recovery_completed_data','')!==kit.id) {
      const current=(await captureHistoryAudit()).snapshot;
      if(current.tasks.length || current.projects.length || current.ops.length || (await listShares()).length) throw new Error('Restore identity on an empty replacement workspace. Export this device before recovering.');
      const previous=IS_TAURI ? await getSecret('crdt_signing_key') : '';
      let committed=false;
      try {
        if(IS_TAURI) {await setSecret('crdt_signing_key',kit.identity.privateKey);if(await getSecret('crdt_signing_key')!==kit.identity.privateKey) throw new Error('Recovered keychain identity could not be verified.');}
        await commitProjection(kit.snapshot.ops,kit.snapshot.tasks,kit.snapshot.projects,{...current,normalizeTask:normalizedTask,fingerprint},
          {...kit.identity,privateKey:await encryptBrowserSecret(kit.identity.privateKey),kitId:kit.id});
        committed=true;
      } finally {if(!committed && IS_TAURI) await setSecret('crdt_signing_key',previous);}
      resetIdentity();resetClock();
    }
  }
  if(kit.relay?.url) await enableSync(kit.relay.url,kit.relay.passphrase);
  for(const share of kit.shares) {const {secret,...meta}=share;await importShareRecord(meta,secret);}
  await setSetting('recovery_last_restored_at',new Date().toISOString());
  return {shares:kit.shares.length,relay:!!kit.relay?.url,identity:kit.v===2};
}
export async function changeRecoveryPassphrase(json:string,oldPassphrase:string,newPassphrase:string):Promise<string> {
  const kit=await openPassword<RecoveryKit|LegacyKit>(oldPassphrase,JSON.parse(json));
  validateCapabilities(kit);
  return JSON.stringify(await sealPassword(newPassphrase,kit));
}
