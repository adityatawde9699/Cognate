/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/logger.js — Structured logging (S8)
   Routes to tauri-plugin-log in native mode,
   falls back to console in browser mode.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { IS_TAURI } from './db.js';

let _tauri = null;
async function getLog() {
    if (!IS_TAURI) return null;
    if (!_tauri) {
        try { _tauri = await import('@tauri-apps/plugin-log'); } catch { /* ignore */ }
    }
    return _tauri;
}

export async function info(msg) { const l = await getLog(); l ? l.info(msg) : console.info('[Cognote]', msg); }
export async function warn(msg) { const l = await getLog(); l ? l.warn(msg) : console.warn('[Cognote]', msg); }
export async function error(msg) { const l = await getLog(); l ? l.error(msg) : console.error('[Cognote]', msg); }
