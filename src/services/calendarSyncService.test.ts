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
  it('extracts only timed, opaque events as busy blocks', () => {
    const busy = parseIcsBusy(ICS);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toEqual({ title: 'Design review', start: '2026-06-25T10:00:00', end: '2026-06-25T11:00:00' });
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
