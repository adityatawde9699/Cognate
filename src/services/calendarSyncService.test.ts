import { describe, it, expect } from 'vitest';
import { parseIcsDateTime, parseIcsBusy } from './calendarSyncService';

describe('parseIcsDateTime', () => {
  it('reads a floating / TZID local date-time as wall-clock', () => {
    expect(parseIcsDateTime('20260625T140000')).toBe('2026-06-25T14:00:00');
  });

  it('parses a UTC instant into a valid local ISO string', () => {
    const out = parseIcsDateTime('20260625T140000Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('returns null for all-day (VALUE=DATE) values', () => {
    expect(parseIcsDateTime('20260625')).toBeNull();
  });
});

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'SUMMARY:Design review',
  'DTSTART;TZID=America/New_York:20260625T100000',
  'DTEND;TZID=America/New_York:20260625T110000',
  'END:VEVENT',
  'BEGIN:VEVENT',           // all-day → not a busy block
  'SUMMARY:Company holiday',
  'DTSTART;VALUE=DATE:20260625',
  'DTEND;VALUE=DATE:20260626',
  'END:VEVENT',
  'BEGIN:VEVENT',           // free/transparent → skipped
  'SUMMARY:Tentative hold',
  'DTSTART:20260625T150000',
  'DTEND:20260625T160000',
  'TRANSP:TRANSPARENT',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcsBusy', () => {
  it('resolves named timezones and includes opaque all-day busy events', () => {
    const busy = parseIcsBusy(ICS);
    expect(busy).toHaveLength(2);
    expect(busy[0]).toEqual({ title: 'Design review', start: '2026-06-25T14:00:00.000Z', end: '2026-06-25T15:00:00.000Z' });
  });

  it('unfolds RFC5545 line continuations', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:A very long meeting',
      '  title that wraps',
      'DTSTART:20260625T090000',
      'DTEND:20260625T093000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const busy = parseIcsBusy(folded);
    expect(busy[0].title).toBe('A very long meeting title that wraps');
  });

  it('skips events missing a start or end', () => {
    const partial = 'BEGIN:VEVENT\r\nSUMMARY:Half\r\nDTSTART:20260625T090000\r\nEND:VEVENT';
    expect(parseIcsBusy(partial)).toHaveLength(0);
  });
});

import { zonedInstant } from './calendarSyncService';
import { busyBlocksForDate } from './planService';
it('expands recurring meetings with exclusions across a timezone DST boundary', () => {
  const feed = ['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:series','SUMMARY:Daily standup',
    'DTSTART;TZID=America/New_York:20260307T090000','DTEND;TZID=America/New_York:20260307T093000',
    'RRULE:FREQ=DAILY;COUNT=4','EXDATE;TZID=America/New_York:20260309T090000','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const events = parseIcsBusy(feed,{start:new Date('2026-03-01Z'),end:new Date('2026-03-20Z')});
  expect(events.map(e=>e.start)).toEqual(['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-10T13:00:00.000Z']);
});
it('rejects ambiguous/nonexistent named-zone times and unknown zones', () => {
  const parts = {year:2026,month:3,day:8,hour:2,minute:30,second:0};
  expect(()=>zonedInstant(parts,'America/New_York')).toThrow('nonexistent');
  expect(()=>zonedInstant({...parts,month:11,day:1,hour:1},'America/New_York')).toThrow('ambiguous');
  expect(()=>zonedInstant(parts,'Imaginary/City')).toThrow();
});
it('clips overnight and all-day meetings on both local calendar dates', () => {
  const event = {id:'night',title:'Overnight',source:'ics',created_at:'',start:'2026-10-06T23:00:00',end:'2026-10-07T02:00:00'};
  expect(busyBlocksForDate([event],'2026-10-06')).toEqual([{start_min:1380,end_min:1440,title:'Overnight'}]);
  expect(busyBlocksForDate([event],'2026-10-07')).toEqual([{start_min:0,end_min:120,title:'Overnight'}]);
  expect(busyBlocksForDate([{...event,start:'2026-10-06T00:00:00',end:'2026-10-07T00:00:00'}],'2026-10-06')[0]).toMatchObject({start_min:0,end_min:1440});
});

it('uses detached recurring exceptions and cancellation instead of the original occurrence',()=>{
  const feed=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:series','DTSTART:20261006T090000Z','DTEND:20261006T100000Z','RRULE:FREQ=DAILY;COUNT=3','END:VEVENT',
    'BEGIN:VEVENT','UID:series','RECURRENCE-ID:20261007T090000Z','DTSTART:20261007T110000Z','DTEND:20261007T120000Z','SUMMARY:Moved','END:VEVENT',
    'BEGIN:VEVENT','UID:series','RECURRENCE-ID:20261008T090000Z','DTSTART:20261008T090000Z','DTEND:20261008T100000Z','STATUS:CANCELLED','END:VEVENT','END:VCALENDAR'].join('\r\n');
  expect(parseIcsBusy(feed,{start:new Date('2026-10-01Z'),end:new Date('2026-10-20Z')}).map(event=>event.start)).toEqual(['2026-10-06T09:00:00.000Z','2026-10-07T11:00:00.000Z']);
});
it('re-expands a retained recurring feed beyond its horizon without changing freshness',async()=>{
  const {DeviceStorage}=await import('./fixtures/fakeBatchRelay');Object.assign(globalThis,{localStorage:new DeviceStorage()});
  const {importBusyText,ensureCalendarCoverage,calendarWarnings}=await import('./calendarSyncService');
  const {getSetting,getCalendarEvents}=await import('../db');
  const feed=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:future','DTSTART:20261006T090000Z','DTEND:20261006T100000Z','RRULE:FREQ=DAILY','END:VEVENT','END:VCALENDAR'].join('\r\n');
  await importBusyText(feed,{start:new Date('2026-10-01Z'),end:new Date('2026-10-10Z')});
  const before=JSON.parse(await getSetting('calendar_meta:ics',''));
  expect((await calendarWarnings('2027-01-15')).some(message=>message.includes('does not cover'))).toBe(true);
  await ensureCalendarCoverage('2027-01-15');
  expect(JSON.parse(await getSetting('calendar_meta:ics','')).refreshedAt).toBe(before.refreshedAt);
  expect((await getCalendarEvents()).some(event=>event.start.startsWith('2027-01-15'))).toBe(true);
  expect((await calendarWarnings('2027-01-15')).some(message=>message.includes('does not cover'))).toBe(false);
});
it('uses feed-local VTIMEZONE rules without leaking them into another import',()=>{
  const feed=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VTIMEZONE','TZID:Custom/Office','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0230','TZOFFSETTO:+0230','END:STANDARD','END:VTIMEZONE','BEGIN:VEVENT','UID:custom','DTSTART;TZID=Custom/Office:20261006T090000','DTEND;TZID=Custom/Office:20261006T100000','END:VEVENT','END:VCALENDAR'].join('\r\n');
  expect(parseIcsBusy(feed)[0].start).toBe('2026-10-06T06:30:00.000Z');
  expect(()=>parseIcsBusy(feed.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/,''))).toThrow();
});
it('expands RDATE alongside RRULE and removes EXDATE',()=>{
  const feed=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:dates','DTSTART:20261006T090000Z','DTEND:20261006T100000Z','RRULE:FREQ=DAILY;COUNT=2','RDATE:20261010T090000Z','EXDATE:20261007T090000Z','END:VEVENT','END:VCALENDAR'].join('\r\n');
  expect(parseIcsBusy(feed,{start:new Date('2026-10-01Z'),end:new Date('2026-10-20Z')}).map(event=>event.start)).toEqual(['2026-10-06T09:00:00.000Z','2026-10-10T09:00:00.000Z']);
});
