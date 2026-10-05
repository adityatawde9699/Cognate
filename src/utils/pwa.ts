/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/utils/pwa.ts — progressive-web-app registration (Act 2)
   Registers the service worker so the browser build is installable on a phone
   and works offline — the capture-first companion on the shared TS core. Never
   runs inside the Tauri desktop shell (it has its own packaging) or in dev.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface SWEnv {
  isTauri: boolean;
  hasServiceWorker: boolean;
  isProd: boolean;
}

/** Pure decision: register only on a real (production) web build, never desktop. */
export function shouldRegisterSW(env: SWEnv): boolean {
  return !env.isTauri && env.hasServiceWorker && env.isProd;
}

function currentEnv(): SWEnv {
  return {
    isTauri: typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    isProd: import.meta.env.PROD,
  };
}

export function registerServiceWorker(): void {
  if (!shouldRegisterSW(currentEnv())) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js',{updateViaCache:'none'})
      .then(registration=>{
        const notify=()=>{if(registration.waiting && navigator.serviceWorker.controller) window.dispatchEvent(new Event('cognate-update-ready'));};
        notify();registration.addEventListener('updatefound',()=>{registration.installing?.addEventListener('statechange',notify);});
      })
      .catch((e) => console.warn('[pwa] service worker registration failed:', e));
  });
}

export async function checkPwaUpdate():Promise<void> {await (await navigator.serviceWorker.getRegistration())?.update();}
export async function requestPersistentStorage():Promise<boolean> {return await navigator.storage?.persist?.() ?? false;}
