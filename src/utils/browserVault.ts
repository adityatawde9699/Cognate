/** At-rest encryption with a non-exportable device key stored as a CryptoKey
 * in IndexedDB. Same-origin script access still grants access to the vault. */
import { seal,open } from '../services/crypto';
const PREFIX='cognate-vault-v1:';
let pending:Promise<CryptoKey>|null=null;
async function key(create=true):Promise<CryptoKey> {
  if(pending) return pending;
  pending=(async()=>{
    const generated=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open('cognate-secret-vault',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('keys');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Secret storage upgrade blocked. Close other tabs.'));
    });
    try {
      return await new Promise<CryptoKey>((resolve,reject)=>{
        const tx=db.transaction('keys','readwrite',{durability:'strict'}),store=tx.objectStore('keys');
        let selected:CryptoKey;let failure:Error|undefined;
        const request=store.get('device');
        request.onsuccess=()=>{if(!request.result && !create){failure=new Error('Browser vault key is missing. Restore a recovery kit.');tx.abort();return;}selected=request.result ?? generated;if(!request.result)store.put(selected,'device');};
        tx.oncomplete=()=>resolve(selected);tx.onabort=tx.onerror=()=>reject(failure ?? tx.error ?? new Error('Secure browser storage unavailable.'));
      });
    } finally{db.close();}
  })();
  try{return await pending;}catch(error){pending=null;throw error;}
}
export function isEncryptedSecret(value:string):boolean{return value.startsWith(PREFIX);}
export async function encryptBrowserSecret(value:string):Promise<string> {
  if(!value || typeof window==='undefined') return value;
  return PREFIX+JSON.stringify(await seal(await key(),value));
}
export async function decryptBrowserSecret(value:string):Promise<string> {
  if(!isEncryptedSecret(value)) return value;
  return open<string>(await key(false),JSON.parse(value.slice(PREFIX.length)));
}
