/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/utils/notify.ts — Desktop notifications
   Uses tauri-plugin-notification in the desktop app, falls
   back to the Web Notification API in the browser. Gated by
   the `notify_enabled` setting (default on).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting } from '../db';
import { recordDiagnostic, failureCode } from '../services/diagnostics';

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

let permissionAsked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;

  if (IS_TAURI) {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
    let granted = await isPermissionGranted();
    if (!granted && !permissionAsked) {
      permissionAsked = true;
      granted = (await requestPermission()) === 'granted';
    }
    permissionGranted = granted;
    return granted;
  }

  // Browser fallback
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') { permissionGranted = true; return true; }
  if (Notification.permission !== 'denied' && !permissionAsked) {
    permissionAsked = true;
    permissionGranted = (await Notification.requestPermission()) === 'granted';
    return permissionGranted;
  }
  return false;
}

/** Show a desktop notification, respecting the user's `notify_enabled` setting. */
export async function notify(title: string, body: string): Promise<'sent' | 'disabled' | 'permission denied' | 'failed'> {
  try {
    const enabled = await getSetting('notify_enabled', '1');
    if (enabled !== '1') return 'disabled';
    if (!(await ensurePermission())) { recordDiagnostic('notification', 'permission'); return 'permission denied'; }

    if (IS_TAURI) {
      const { sendNotification } = await import('@tauri-apps/plugin-notification');
      sendNotification({ title, body });
    } else if (typeof Notification !== 'undefined') {
      const notification = new Notification(title, { body });
      notification.onclick = () => { window.focus(); notification.close(); };
    }
    recordDiagnostic('notification', 'ok'); return 'sent';
  } catch (e) {
    // Notifications are best-effort — never let them break a flow.
    recordDiagnostic('notification', failureCode(e)); return 'failed';
  }
}
