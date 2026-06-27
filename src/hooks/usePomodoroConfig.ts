/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/hooks/usePomodoroConfig.ts
   Pushes the saved Pomodoro settings into the Rust timer
   (the source of truth) on mount and whenever settings change.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect } from 'react';
import { getSetting } from '../db';

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

export function usePomodoroConfig(): void {
  useEffect(() => {
    if (!IS_TAURI) return; // timer is Tauri-only

    let cancelled = false;

    const push = async () => {
      const [work, short, long, auto] = await Promise.all([
        getSetting('pomo_work_mins', '25'),
        getSetting('pomo_short_break_mins', '5'),
        getSetting('pomo_long_break_mins', '15'),
        getSetting('pomo_auto_break', '0'),
      ]);
      if (cancelled) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_pomodoro_config', {
        workMins: parseInt(work, 10) || 25,
        shortBreakMins: parseInt(short, 10) || 5,
        longBreakMins: parseInt(long, 10) || 15,
        autoStartBreak: auto === '1',
      }).catch((e) => console.warn('[pomodoro-config] failed:', e));
    };

    push();
    const onChange = () => push();
    window.addEventListener('settings-changed', onChange);
    return () => { cancelled = true; window.removeEventListener('settings-changed', onChange); };
  }, []);
}
