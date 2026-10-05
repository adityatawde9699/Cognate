import type { Recurrence } from '../store';
/** Calendar recurrence: monthly dates clamp to the next month's last day. */
export function nextDeadline(base: string, recurrence: Recurrence): string {
  const date = base ? new Date(`${base}T12:00:00`) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid recurrence date.');
  if (recurrence === 'daily') date.setDate(date.getDate() + 1);
  else if (recurrence === 'weekly') date.setDate(date.getDate() + 7);
  else if (recurrence === 'monthly') {
    const day = date.getDate();
    date.setDate(1); date.setMonth(date.getMonth() + 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, last));
  }
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function recurrenceId(id: string, deadline: string): string {
  return `${id.split(':recurrence:')[0]}:recurrence:${deadline}`;
}
