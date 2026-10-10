import {useEffect,useState} from 'react';
import {IS_TAURI} from '../db';
import {checkPwaUpdate,requestPersistentStorage} from '../utils/pwa';
/** Workers activate after all old clients close; never interrupt an editor. */
export function PwaStatus() {
  const [waiting,setWaiting]=useState(false),[storage,setStorage]=useState('');
  useEffect(()=>{
    if(IS_TAURI || !('serviceWorker' in navigator)) return;
    const ready=()=>setWaiting(true);
    window.addEventListener('cognate-update-ready',ready);
    navigator.serviceWorker.getRegistration().then(registration=>setWaiting(!!registration?.waiting));
    navigator.storage?.persisted?.().then(persisted=>{if(!persisted)setStorage('Browser storage can be cleared. Keep a recovery copy.');}).catch(()=>{});
    return ()=>window.removeEventListener('cognate-update-ready',ready);
  },[]);
  if(IS_TAURI || (!waiting && !storage)) return null;
  return <aside className="app-notice" aria-label="Application update and storage" role="status">
    <i className="fa-solid fa-shield-halved" aria-hidden="true" />
    {waiting && <p>An update is ready. Save your work, then close all Cognate tabs and reopen the app to install it. If an update fails, your current offline version stays available.</p>}
    {storage && <p>{storage} <button className="btn-ghost" onClick={async()=>setStorage(await requestPersistentStorage()?'Persistent storage enabled. Keep recovery exports for device loss.':'This browser did not grant persistent storage. Keep a recovery export.')}>Protect offline storage</button></p>}
    <button className="btn-ghost" onClick={()=>checkPwaUpdate().catch(()=>setStorage('Could not check for updates. Your current offline version remains available.'))}>Check for updates</button>
  </aside>;
}
