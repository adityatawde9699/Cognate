/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/hooks/useMorningBrief.ts (Act 4)
   Fires one proactive morning-brief notification per day (mornings only, after
   tasks hydrate), respecting the user's notification setting. Deterministic
   headline from the chief-of-staff service — the app reaching out first.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect } from 'react';
import { useStore } from '../store';
import { getSetting, setSetting } from '../db';
import { morningBrief } from '../services/chiefOfStaff';
import { notify } from '../utils/notify';

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function useMorningBrief(): void {
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const now = new Date();
        if (now.getHours() >= 12) return; // morning only
        const today = ymd(now);
        if ((await getSetting('last_morning_brief', '')) === today) return;
        const tasks = useStore.getState().currentTasks;
        if (tasks.length === 0) return;
        await notify('Your day ahead', morningBrief(tasks, now).headline);
        await setSetting('last_morning_brief', today);
      } catch {
        // Best-effort — never block startup.
      }
    }, 15_000); // let tasks hydrate first
    return () => clearTimeout(t);
  }, []);
}
