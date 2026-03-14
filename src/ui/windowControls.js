/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/windowControls.js — Native OS integration (S5)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { IS_TAURI } from '../db.js';

export async function initWindowControls() {
    if (!IS_TAURI) return;
    try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const { invoke } = await import('@tauri-apps/api/core');

        const win = getCurrentWebviewWindow();

        document.getElementById('btnMinimize').addEventListener('click', () => win.minimize());
        document.getElementById('btnMaximize').addEventListener('click', () => win.toggleMaximize());
        // Custom close for system tray (M7)
        document.getElementById('btnClose').addEventListener('click', () => win.hide());

        // S5: Wire app_ready to show version
        const version = await invoke('app_ready');
        document.querySelector('.tb-name').textContent = `Cognote v${version}`;

        // Show window after frontend mounts
        await win.show();
    } catch (e) {
        console.warn('Window controls not available:', e);
    }
}
