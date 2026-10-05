import ICAL from 'ical.js';
import {getSecret,setSecret} from '../utils/secrets';
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
  replaceCalendarSource,
  getCalendarEvents,
} from '../db';

export const ICS_SOURCE = 'ics';

export interface BusyEvent {
  title: string;
  start: string; // UTC instant, ISO 8601
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

/** Convert a named-zone wall time using the runtime timezone database.
 * Reject ambiguous/nonexistent wall times rather than silently moving meetings. */
export function zonedInstant(parts: {year:number;month:number;day:number;hour:number;minute:number;second:number}, zone:string): Date {
  const formatter = new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const wall = Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
  const offsets = new Set<number>();
  const wallAt = (ms:number) => {
    const values = Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    return Date.UTC(values.year,values.month-1,values.day,values.hour,values.minute,values.second);
  };
  for (const delta of [-86400000,0,86400000]) offsets.add(wallAt(wall+delta)-(wall+delta));
  const candidates = [...offsets].map(offset=>wall-offset).filter(ms=>wallAt(ms)===wall);
  if (candidates.length!==1) throw new Error(`Calendar time is ambiguous or nonexistent in ${zone}. Export that event with a UTC offset.`);
  return new Date(candidates[0]);
}
function instant(time: InstanceType<typeof ICAL.Time>, zone?: string): Date {
  if (time.zone.tzid!=='floating') return new Date(time.toUnixTime()*1000);
  if (zone) return zonedInstant(time,zone);
  const date = new Date(time.year,time.month-1,time.day,time.hour,time.minute,time.second);
  if (date.getFullYear()!==time.year || date.getMonth()+1!==time.month || date.getDate()!==time.day || date.getHours()!==time.hour || date.getMinutes()!==time.minute) throw new Error('Calendar has a nonexistent local time. Export with UTC offsets.');
  return date;
}
export interface CalendarRange {start: Date; end: Date}
/** RFC 5545 recurrence/exception expansion is bounded. A rejected feed leaves
 * the previous persisted source intact; expansion never silently truncates. */
export function parseIcsBusy(text: string, range?: CalendarRange): BusyEvent[] {
  if (text.length>1_000_000) throw new Error('Calendar feed exceeds 1 MB.');
  const root = new ICAL.Component(ICAL.parse(text));
  const components = root.name==='vevent' ? [root] : root.getAllSubcomponents('vevent');
  if (components.length>10000) throw new Error('Too many calendar events.');
  const now = new Date();
  const horizon = range ?? {start:new Date(+now-30*86400000),end:new Date(+now+180*86400000)};
  if (!Number.isFinite(+horizon.start) || !Number.isFinite(+horizon.end) || horizon.end<=horizon.start) throw new Error('Invalid calendar expansion horizon.');
  const out: BusyEvent[] = [];
  const exceptions=components.filter(c=>c.hasProperty('recurrence-id'));
  const zones=root.getAllSubcomponents('vtimezone').map(c=>new ICAL.Timezone(c));
  const previousZones=zones.map(zone=>({id:zone.tzid,previous:ICAL.TimezoneService.get(zone.tzid)}));
  for(const zone of zones) ICAL.TimezoneService.register(zone,zone.tzid);
  try {
  let iterations = 0;
  const add = (event: InstanceType<typeof ICAL.Event>, start: InstanceType<typeof ICAL.Time>, end: InstanceType<typeof ICAL.Time>) => {
    const component = event.component;
    if (component.getFirstPropertyValue('transp')==='TRANSPARENT' || component.getFirstPropertyValue('status')==='CANCELLED') return;
    const startZone = component.getFirstProperty('dtstart')?.getParameter('tzid');
    const endZone = component.getFirstProperty('dtend')?.getParameter('tzid') ?? startZone;
    const from = instant(start,typeof startZone==='string' ? startZone : undefined);
    const to = instant(end,typeof endZone==='string' ? endZone : undefined);
    if (to<=from) throw new Error('Calendar event ends before its start.');
    out.push({title:event.summary || 'Busy',start:from.toISOString(),end:to.toISOString()});
    if (out.length>10000) throw new Error('Calendar expansion exceeds 10000 occurrences. Use a shorter horizon.');
  };
  for (const component of components) {
    if (!component.hasProperty('dtstart') || (!component.hasProperty('dtend') && !component.hasProperty('duration'))) continue;
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException() && components.some(master=>!master.hasProperty('recurrence-id') && master.getFirstPropertyValue('uid')===component.getFirstPropertyValue('uid'))) continue;
    for(const exception of exceptions) if(exception.getFirstPropertyValue('uid')===component.getFirstPropertyValue('uid')) event.relateException(new ICAL.Event(exception));
    if (!event.isRecurring()) {add(event,event.startDate,event.endDate);continue;}
    const iterator = event.iterator();
    for (let next=iterator.next();next;next=iterator.next()) {
      if (++iterations>50000) throw new Error('Calendar recurrence expansion limit exceeded.');
      const occurrence = event.getOccurrenceDetails(next);
      const tzid = occurrence.item.component.getFirstProperty('dtstart')?.getParameter('tzid');
      const start = instant(occurrence.startDate,typeof tzid==='string' ? tzid : undefined);
      const end = instant(occurrence.endDate,typeof tzid==='string' ? tzid : undefined);
      if (start>=horizon.end) break;
      if (end>horizon.start) add(occurrence.item,occurrence.startDate,occurrence.endDate);
    }
  }
  return out;
  } finally { for(const {id,previous} of previousZones) {if(previous)ICAL.TimezoneService.register(previous,id);else ICAL.TimezoneService.remove(id);} }
}

export interface CalendarMetadata {v:2; refreshedAt:string; start:string; end:string; timezone:string; kind:'ics'|'oauth'}
export function defaultCalendarRange(now=new Date()):CalendarRange {return {start:new Date(+now-30*86400000),end:new Date(+now+180*86400000)};}
export function calendarMetadata(range:CalendarRange,kind:'ics'|'oauth'):CalendarMetadata {
  return {v:2,refreshedAt:new Date().toISOString(),start:range.start.toISOString(),end:range.end.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,kind};
}
export async function calendarWarnings(date:string,now=Date.now()):Promise<string[]> {
  const warnings:string[]=[];
  const start=+new Date(`${date}T00:00:00`),end=+new Date(`${date}T23:59:59.999`);
  for(const source of ['ics','oauth']) {
    const raw=await getSetting(`calendar_meta:${source}`,'');
    if(!raw) {if((await getCalendarEvents()).some(event=>event.source===source)) warnings.push('Legacy calendar timezone and coverage are unknown. Refresh or reimport this source.');continue;}
    const meta:CalendarMetadata=JSON.parse(raw);
    if(start<Date.parse(meta.start) || end>=Date.parse(meta.end)) warnings.push(`${source==='ics'?'Imported':'Connected'} calendar does not cover this day. Refresh before planning.`);
    if(now-Date.parse(meta.refreshedAt)>24*3600000) warnings.push(`${source==='ics'?'Imported':'Connected'} calendar is more than a day old.`);
    if(meta.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone) warnings.push('Calendar timezone changed. Refresh floating and all-day events.');
  }
  return warnings;
}
export async function persistBusy(events:BusyEvent[],range=defaultCalendarRange()):Promise<number> {
  await replaceCalendarSource(ICS_SOURCE,events,calendarMetadata(range,'ics'));
  return events.length;
}
export async function importBusyText(text:string,range=defaultCalendarRange()):Promise<number> {
  const count=await persistBusy(parseIcsBusy(text,range),range);
  await setSecret('calendar_ics_feed',text);
  return count;
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
export async function syncCalendarUrl(url?: string,range?:CalendarRange): Promise<number> {
  const feed = (url ?? (await getCalendarUrl())).trim();
  if (!feed) throw new Error('No calendar URL set. Add one in Settings → Calendar.');
  if (!IS_TAURI) {
    throw new Error('Subscribing to a calendar URL needs the desktop app. Paste the .ics text instead.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const text = await invoke<string>('fetch_ics', { url: feed });
  const count=await importBusyText(text,range);
  if (url !== undefined) await setCalendarUrl(feed);
  return count;
}

/** Expand outside a stored horizon before solving. Cached feed re-expansion
 * changes coverage without pretending it was fetched again. */
export async function ensureCalendarCoverage(date:string):Promise<void> {
  const target=new Date(`${date}T00:00:00`),end=new Date(`${date}T23:59:59.999`);
  const raw=await getSetting('calendar_meta:ics','');
  if(raw) {
    const meta:CalendarMetadata=JSON.parse(raw);
    if(+target<Date.parse(meta.start) || +end>=Date.parse(meta.end) || meta.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone) {
      const range={start:new Date(+target-30*86400000),end:new Date(+target+180*86400000)};
      if(IS_TAURI && await getCalendarUrl()) await syncCalendarUrl(undefined,range);
      else {
        const feed=await getSecret('calendar_ics_feed');
        if(!feed) throw new Error('Calendar does not cover this day. Reimport the feed before planning.');
        const events=parseIcsBusy(feed,range);
        await replaceCalendarSource(ICS_SOURCE,events,{...calendarMetadata(range,'ics'),refreshedAt:meta.refreshedAt});
      }
    }
  }
  const oauthRaw=await getSetting('calendar_meta:oauth','');
  if(oauthRaw) {
    const meta:CalendarMetadata=JSON.parse(oauthRaw);
    if(+target<Date.parse(meta.start) || +end>=Date.parse(meta.end)) {
      if(!IS_TAURI) throw new Error('Connected calendar does not cover this day. Refresh on desktop before planning.');
      await (await import('./oauthCalendarService')).syncFreeBusy(7,target);
    }
  }
}
