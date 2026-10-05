/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/hooks/useAutoReflow.ts
   Turns "a plan" into "a plan that tracks reality": periodically checks
   whether today's schedule has drifted (a meeting landed on planned work,
   or a block ran over) and, if so, re-plans the remaining hours and tells
   the user what changed. Conservative — only fires on real disruption and
   at most once every few minutes.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect } from 'react';
import { reflowIfDisrupted } from '../services/planService';
import { notify } from '../utils/notify';
import { toast } from '../utils/toast';

const CHECK_MS = 5 * 60 * 1000;   // scan every 5 minutes
const COOLDOWN_MS = 5 * 60 * 1000; // never re-plan more than once per 5 min

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function useAutoReflow(): void {
  useEffect(() => {
    let lastReflow = 0;
    let stopped = false;
    let running = false;
    const controller = new AbortController();

    const scan = async (force=false) => {
      if (stopped || running) return;
      if (!force && Date.now() - lastReflow < COOLDOWN_MS) return;
      running = true;
      try {
        const r = await reflowIfDisrupted(todayStr(),controller.signal);
        if (stopped) return;
        if (r) {
          lastReflow = Date.now();
          const n = r.result.blocks.length;
          notify('Day re-planned', `Adjusted around ${r.disruption.reason}.`);
          toast(`🔄 Re-planned around ${r.disruption.reason} · ${n} block${n === 1 ? '' : 's'}`);
        }
      } catch (error) {
        if (!stopped) console.warn('[planner] Reflow did not commit:',error);
      } finally { running = false; }
    };

    // Delay the first scan so tasks/events have hydrated.
    let debounce:ReturnType<typeof setTimeout>|undefined;
    const changed=()=>{clearTimeout(debounce);debounce=setTimeout(()=>void scan(true),1000);};
    window.addEventListener('calendar-changed',changed);
    const first = setTimeout(scan, 12000);
    const interval = setInterval(scan, CHECK_MS);
    return () => { stopped = true; controller.abort(); clearTimeout(first); clearInterval(interval);clearTimeout(debounce);window.removeEventListener('calendar-changed',changed); };
  }, []);
}
