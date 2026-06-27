/* iCalendar (.ics) interop — the local-first "calendar sync".
   Export deadlined tasks as all-day VEVENTs (importable / subscribable
   in Google, Outlook, Apple Calendar) and import .ics events as tasks. */
import { Task } from '../store';
import { downloadStr } from '../utils/export';
import { addTask } from './taskService';

function escapeIcs(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function unescapeIcs(s: string): string {
  return (s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function ymdCompact(d: string): string { return d.replace(/-/g, ''); }
function stampUtc(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** Build an iCalendar document from tasks that have a deadline. */
export function tasksToIcs(tasks: Task[]): string {
  const events = tasks
    .filter((t) => t.deadline)
    .map((t) => {
      const start = ymdCompact(t.deadline);
      // DTEND for an all-day event is exclusive → next day.
      const endDate = new Date(t.deadline + 'T00:00:00');
      endDate.setDate(endDate.getDate() + 1);
      const end = ymdCompact(
        endDate.getFullYear() + '-' + String(endDate.getMonth() + 1).padStart(2, '0') + '-' + String(endDate.getDate()).padStart(2, '0')
      );
      return [
        'BEGIN:VEVENT',
        `UID:${t.id}@cognate`,
        `DTSTAMP:${stampUtc()}`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${end}`,
        `SUMMARY:${escapeIcs(t.title)}`,
        t.description ? `DESCRIPTION:${escapeIcs(t.description)}` : '',
        `STATUS:${t.done ? 'CONFIRMED' : 'TENTATIVE'}`,
        t.tags?.length ? `CATEGORIES:${t.tags.map(escapeIcs).join(',')}` : '',
        'END:VEVENT',
      ].filter(Boolean).join('\r\n');
    });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cognate//Tasks//EN',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

export interface IcsDraft { title: string; deadline: string; description: string }

/** Parse an .ics document into task drafts (one per VEVENT with a date). */
export function parseIcs(text: string): IcsDraft[] {
  // Unfold RFC5545 line continuations (a line starting with space/tab continues the previous).
  const lines = text.replace(/\r\n/g, '\n').split('\n').reduce<string[]>((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.slice(1);
    else acc.push(line);
    return acc;
  }, []);

  const drafts: IcsDraft[] = [];
  let cur: Partial<IcsDraft> | null = null;
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) cur = {};
    else if (line.startsWith('END:VEVENT')) {
      if (cur?.title && cur.deadline) drafts.push({ title: cur.title, deadline: cur.deadline, description: cur.description || '' });
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx);
      const val = line.slice(idx + 1);
      if (key.startsWith('SUMMARY')) cur.title = unescapeIcs(val);
      else if (key.startsWith('DESCRIPTION')) cur.description = unescapeIcs(val);
      else if (key.startsWith('DTSTART')) {
        const m = val.match(/(\d{4})(\d{2})(\d{2})/);
        if (m) cur.deadline = `${m[1]}-${m[2]}-${m[3]}`;
      }
    }
  }
  return drafts;
}

export function exportIcs(tasks: Task[]): number {
  const dated = tasks.filter((t) => t.deadline);
  downloadStr(tasksToIcs(tasks), 'cognate-tasks.ics', 'text/calendar');
  return dated.length;
}

export async function importIcsText(text: string): Promise<number> {
  const drafts = parseIcs(text);
  for (const d of drafts) {
    await addTask({ title: d.title, description: d.description, deadline: d.deadline, tags: [], importance: 3, effort: 3 });
  }
  return drafts.length;
}
