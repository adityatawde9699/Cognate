/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/webhookService.ts
   Posts task events to configured Slack / Discord webhooks via
   the Rust `send_notification` command (avoids browser CORS).
   Fire-and-forget — failures never block the UI.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { Task } from '../store';
import { getSetting } from '../db';
import { getSecret } from '../utils/secrets';

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

async function post(platform: 'slack' | 'discord', urlOrToken: string, message: string) {
  if (!urlOrToken) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('send_notification', { platform, urlOrToken, message });
  } catch (e) {
    console.warn(`[webhook] ${platform} post failed:`, e);
  }
}

async function broadcast(message: string) {
  const [slack, discord] = await Promise.all([
    getSecret('int_slack'),
    getSecret('int_discord'),
  ]);
  await Promise.all([post('slack', slack, message), post('discord', discord, message)]);
}

/** Announce a completed task, if the user enabled webhook-on-complete. */
export async function notifyTaskComplete(task: Task): Promise<void> {
  if (!IS_TAURI) return;
  const enabled = await getSetting('webhook_on_complete', '0');
  if (enabled !== '1') return;
  await broadcast(`✅ Completed: ${task.title}`);
}

function todayStr(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Post a deadline alert for a task, deduped once per task per day. */
export async function notifyDeadlineWebhook(task: Task): Promise<void> {
  if (!IS_TAURI) return;
  if ((await getSetting('webhook_deadlines', '0')) !== '1') return;
  const day = todayStr();
  const key = `wh:deadline:${task.id}:${day}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  const overdue = task.deadline < day;
  await broadcast(`${overdue ? '⚠️ Overdue' : '⏰ Due today'}: ${task.title}`);
}

/** Post a once-per-day digest of the board, if enabled. */
export async function sendDailyDigest(tasks: Task[]): Promise<void> {
  if (!IS_TAURI) return;
  if ((await getSetting('webhook_digest', '0')) !== '1') return;
  const day = todayStr();
  if (localStorage.getItem(`wh:digest:${day}`)) return;
  localStorage.setItem(`wh:digest:${day}`, '1');

  const open = tasks.filter((t) => !t.done);
  const dueToday = open.filter((t) => t.deadline === day);
  const overdue = open.filter((t) => t.deadline && t.deadline < day);
  const flagged = open.filter((t) => t.priority === 'high');

  const lines = [
    `🗓️ *Cognate daily digest — ${day}*`,
    `• ${open.length} open · ${dueToday.length} due today · ${overdue.length} overdue · ${flagged.length} flagged`,
  ];
  if (dueToday.length) lines.push('', 'Due today:', ...dueToday.slice(0, 8).map((t) => `  – ${t.title}`));
  if (overdue.length) lines.push('', 'Overdue:', ...overdue.slice(0, 8).map((t) => `  – ${t.title} (${t.deadline})`));
  await broadcast(lines.join('\n'));
}
