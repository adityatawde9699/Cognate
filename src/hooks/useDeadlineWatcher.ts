/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/hooks/useDeadlineWatcher.ts
   Periodically notifies about not-done tasks that are due today
   or overdue. Each task is announced at most once per day
   (deduped in localStorage).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect } from 'react';
import { useStore } from '../store';
import { notify } from '../utils/notify';
import { notifyDeadlineWebhook, sendDailyDigest } from '../services/webhookService';

const CHECK_MS = 30 * 60 * 1000; // every 30 minutes

function todayStr(): string {
  const d = new Date();
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function alreadyNotified(id: string, day: string): boolean {
  const key = `notified:${id}:${day}`;
  if (localStorage.getItem(key)) return true;
  localStorage.setItem(key, '1');
  return false;
}

export function useDeadlineWatcher(): void {
  useEffect(() => {
    const scan = () => {
      const day = todayStr();
      const tasks = useStore.getState().currentTasks;
      const due = tasks.filter(
        (t) => !t.done && t.deadline && t.deadline <= day
      );
      for (const t of due) {
        // Webhook deadline alerts dedupe independently of desktop notifications.
        void notifyDeadlineWebhook(t);
        if (alreadyNotified(t.id, day)) continue;
        const overdue = t.deadline < day;
        notify(
          overdue ? 'Task overdue' : 'Task due today',
          `${t.title}${overdue ? ` — was due ${t.deadline}` : ''}`
        );
      }
      // Once-per-day webhook digest.
      void sendDailyDigest(tasks);
    };

    // Slight delay on first run so tasks have hydrated.
    const first = setTimeout(scan, 8000);
    const interval = setInterval(scan, CHECK_MS);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);
}
