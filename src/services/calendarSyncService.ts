/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/calendarSyncService.ts — Calendar busy-time ingest (Act 1)
   ──────────────────────────────────────────────────────
   Pull real meetings out of an iCalendar (.ics) feed so the planner
   schedules *around* them. A subscription URL is fetched in Rust
   (`fetch_ics`, desktop only — CORS blocks the browser); pasted .ics
   text works everywhere. Timed VEVENTs become `calendar_events` rows
   tagged `source: 'ics'`, which the planner already treats as busy.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import {
  IS_TAURI,
  getSetting,
  setSetting,
  clearCalendarSource,
  createCalendarEvent,
} from '../db';

export const ICS_SOURCE = 'ics';

export interface BusyEvent {
  title: string;
  start: string; // local ISO 'YYYY-MM-DDTHH:MM:SS'
  end: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Parse an ICS date-time property value into a local wall-clock ISO string,
 * or null for all-day (VALUE=DATE) events — those aren't "busy" blocks.
 *
 *  - `20260625T140000Z`  → UTC, converted to the user's local time
 *  - `20260625T140000`   → floating / TZID local time, used as-is
 *  - `20260625`          → all-day → null
 */
export function parseIcsDateTime(raw: string): string | null {
  const v = raw.trim();
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dt) {
    const [, y, mo, d, h, mi, s, z] = dt;
    if (z) {
      // UTC instant → render in the user's local zone.
      const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
      return fmtLocal(new Date(ms));
    }
    // Floating / TZID: treat the components as local wall-clock time.
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  return null; // VALUE=DATE (all-day) or unrecognized
}

function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .reduce<string[]>((acc, line) => {
      if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.slice(1);
      else acc.push(line);
      return acc;
    }, []);
}

function unescapeText(s: string): string {
  return (s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/**
 * Parse an .ics document into timed busy events. All-day events, events
 * without both a start and end, and zero/negative-length spans are skipped.
 */
export function parseIcsBusy(text: string): BusyEvent[] {
  const lines = unfold(text);
  const out: BusyEvent[] = [];
  let cur: { title?: string; start?: string | null; end?: string | null; transparent?: boolean } | null = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      cur = {};
      continue;
    }
    if (line.startsWith('END:VEVENT')) {
      if (cur && cur.start && cur.end && !cur.transparent && cur.end > cur.start) {
        out.push({ title: cur.title || 'Busy', start: cur.start, end: cur.end });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx); // may carry params, e.g. DTSTART;TZID=...
    const val = line.slice(idx + 1);
    const name = key.split(';')[0].toUpperCase();

    if (name === 'SUMMARY') cur.title = unescapeText(val);
    else if (name === 'DTSTART') cur.start = parseIcsDateTime(val);
    else if (name === 'DTEND') cur.end = parseIcsDateTime(val);
    else if (name === 'TRANSP' && val.trim().toUpperCase() === 'TRANSPARENT') cur.transparent = true;
  }
  return out;
}

/** Persist parsed busy events, replacing any previously-synced ICS events. */
export async function persistBusy(events: BusyEvent[]): Promise<number> {
  await clearCalendarSource(ICS_SOURCE);
  for (const e of events) {
    await createCalendarEvent({ title: e.title, start: e.start, end: e.end, source: ICS_SOURCE });
  }
  return events.length;
}

/** Ingest pasted .ics text. Works in the browser and desktop alike. */
export async function importBusyText(text: string): Promise<number> {
  return persistBusy(parseIcsBusy(text));
}

/** Remember the subscription URL so it can be refreshed later. */
export async function setCalendarUrl(url: string): Promise<void> {
  await setSetting('calendar_ics_url', url.trim());
}
export async function getCalendarUrl(): Promise<string> {
  return (await getSetting('calendar_ics_url', '')) || '';
}

/**
 * Fetch + ingest the subscribed .ics feed. Desktop only — the browser
 * can't fetch arbitrary calendar URLs (CORS); there, paste the text.
 */
export async function syncCalendarUrl(url?: string): Promise<number> {
  const feed = (url ?? (await getCalendarUrl())).trim();
  if (!feed) throw new Error('No calendar URL set. Add one in Settings → Calendar.');
  if (!IS_TAURI) {
    throw new Error('Subscribing to a calendar URL needs the desktop app. Paste the .ics text instead.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const text = await invoke<string>('fetch_ics', { url: feed });
  if (url !== undefined) await setCalendarUrl(feed);
  return importBusyText(text);
}
