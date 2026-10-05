/** Versioned, transactional browser workspace. Legacy storage is retained as a
 * migration snapshot; optimistic revisions reject stale cross-tab writes. */
export interface BrowserWorkspace {
  version: 1;
  tasks: any[];
  projects: any[];
  ops: any[];
  actor: string;
  hlc?: {wall:number;counter:number;actor:string};
  settings?: Record<string,string>;
  calendar_events?: any[];
  milestones?: any[];
  templates?: any[];
}
export interface StoredWorkspace { revision: number; state: BrowserWorkspace }
const DATABASE = 'cognate-workspace';
let pending: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (pending) return pending;
  pending = new Promise((resolve,reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable. Browser data cannot be safely stored.')); return; }
    const request = indexedDB.open(DATABASE,1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workspace');
      request.result.createObjectStore('migration');
    };
    request.onerror = () => { pending=null; reject(request.error); };
    request.onblocked = () => { pending=null; reject(new Error('Storage upgrade blocked. Close other Cognate tabs and retry.')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); pending=null; };
      resolve(db);
    };
  });
  return pending;
}
function legacySnapshot(): Record<string,string> {
  const snapshot: Record<string,string> = {};
  for (let i=0;i<localStorage.length;i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('cn_')) snapshot[key] = localStorage.getItem(key) ?? '';
  }
  return snapshot;
}
export async function readBrowserWorkspace(migrate: () => BrowserWorkspace): Promise<StoredWorkspace> {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(['workspace','migration'],'readwrite', {durability:'strict'});
    let result: StoredWorkspace;
    let failure: unknown;
    const request = tx.objectStore('workspace').get('main');
    request.onsuccess = () => {
      try {
        result = request.result;
        if (!result) {
          const original = legacySnapshot();
          result = { revision:0, state:migrate() };
          tx.objectStore('migration').put({version:1,completed_at:new Date().toISOString(),original},'localStorage-v1');
          tx.objectStore('workspace').put(result,'main');
        }
        if (result.state?.version!==1 || !Array.isArray(result.state.tasks) || !Array.isArray(result.state.ops) ||
            !Array.isArray(result.state.projects) || !Number.isSafeInteger(result.revision) || result.revision<0) {
          throw new Error('Damaged or unsupported browser workspace. Restore a verified export.');
        }
      } catch(error) { failure=error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(structuredClone(result));
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Browser storage read/migration failed.'));
  });
}
export async function writeBrowserWorkspace(state: BrowserWorkspace, expectedRevision: number): Promise<StoredWorkspace> {
  const db = await database();
  const copy = structuredClone(state);
  return new Promise((resolve,reject) => {
    const tx = db.transaction('workspace','readwrite', {durability:'strict'});
    const store = tx.objectStore('workspace');
    const request = store.get('main');
    let result: StoredWorkspace;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        if (!request.result || request.result.revision!==expectedRevision) {
          throw new Error('Workspace changed in another tab. Reload and retry your change.');
        }
        if (expectedRevision===Number.MAX_SAFE_INTEGER) throw new Error('Workspace revision exhausted.');
        result = {revision:expectedRevision+1,state:copy};
        store.put(result,'main');
      } catch(error) { failure=error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Browser storage write failed. Your previous data is intact.'));
  });
}

/** Apply a small independent intent to the current record inside one transaction.
 * Whole task/history replacements must still use revision-checked writes. */
export async function patchBrowserWorkspace(patch: (state: BrowserWorkspace) => void): Promise<StoredWorkspace> {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction('workspace','readwrite', {durability:'strict'});
    const store = tx.objectStore('workspace');
    let result: StoredWorkspace;
    let failure: unknown;
    const request = store.get('main');
    request.onsuccess = () => {
      try {
        const current: StoredWorkspace = request.result;
        if (!current || !Number.isSafeInteger(current.revision) || current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new Error('Browser workspace is unavailable or its revision is exhausted.');
        }
        patch(current.state);
        result = { revision:current.revision+1, state:current.state };
        store.put(result,'main');
      } catch (error) { failure=error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(structuredClone(result));
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Browser storage write failed. Your previous data is intact.'));
  });
}

/** Once encrypted storage is verified, remove plaintext secret copies from the
 * retained migration snapshot. Task/history migration evidence stays intact. */
export async function redactLegacySecret(key:string):Promise<void> {
  const db=await database();
  await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('migration','readwrite',{durability:'strict'}),store=tx.objectStore('migration');
    let failure:unknown;
    const request=store.get('localStorage-v1');
    request.onsuccess=()=>{
      try {
      const snapshot=request.result;if(!snapshot?.original)return;
      delete snapshot.original[`cn_set_${key}`];
      const raw=snapshot.original.cn_atomic_workspace_v1;
      if(raw) {const state=JSON.parse(raw);if(state.settings)delete state.settings[key];snapshot.original.cn_atomic_workspace_v1=JSON.stringify(state);}
      store.put(snapshot,'localStorage-v1');
      } catch(error){failure=error;tx.abort();}
    };
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failure ?? tx.error ?? new Error('Legacy secret cleanup failed.'));
  });
  localStorage.removeItem(`cn_set_${key}`);
  const raw=localStorage.getItem('cn_atomic_workspace_v1');
  if(raw){const state=JSON.parse(raw);if(state.settings)delete state.settings[key];localStorage.setItem('cn_atomic_workspace_v1',JSON.stringify(state));}
}
