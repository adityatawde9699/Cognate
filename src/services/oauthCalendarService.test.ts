import { describe, it, expect } from 'vitest';
import {
  generateVerifier, challengeFromVerifier, buildAuthUrl,
  mapGoogleFreeBusy, mapOutlookView, utcIsoToLocal, tokenExpired,
} from './oauthCalendarService';

describe('oauth calendar — PKCE', () => {
  it('generates url-safe verifiers of adequate length', () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, or = padding
  });

  it('derives a stable S256 challenge per verifier', async () => {
    const v = 'a-fixed-verifier-value-for-determinism';
    const c1 = await challengeFromVerifier(v);
    const c2 = await challengeFromVerifier(v);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await challengeFromVerifier('different')).not.toBe(c1);
  });

  it('builds an auth URL with the PKCE + scope params', () => {
    const url = new URL(buildAuthUrl('google', 'client-123', 'CHALLENGE', 'STATE'));
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(q.get('client_id')).toBe('client-123');
    expect(q.get('code_challenge')).toBe('CHALLENGE');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toContain('freebusy');
  });
});

describe('oauth calendar — free/busy mappers', () => {
  it('converts a UTC instant to local wall-clock ISO (no Z)', () => {
    expect(utcIsoToLocal('2026-06-25T12:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(utcIsoToLocal('2026-06-25T12:00:00Z')).not.toContain('Z');
  });

  it('maps a Google freeBusy response across calendars', () => {
    const json = {
      calendars: {
        primary: { busy: [{ start: '2026-06-25T09:00:00Z', end: '2026-06-25T10:00:00Z' }] },
        team: { busy: [{ start: '2026-06-25T14:00:00Z', end: '2026-06-25T15:00:00Z' }] },
      },
    };
    const out = mapGoogleFreeBusy(json);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.title === 'Busy' && b.start < b.end)).toBe(true);
  });

  it('maps Microsoft calendarView, skipping free time', () => {
    const json = {
      value: [
        { subject: 'Standup', start: { dateTime: '2026-06-25T09:00:00' }, end: { dateTime: '2026-06-25T09:15:00' }, showAs: 'busy' },
        { subject: 'Hold', start: { dateTime: '2026-06-25T12:00:00' }, end: { dateTime: '2026-06-25T13:00:00' }, showAs: 'free' },
      ],
    };
    const out = mapOutlookView(json);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Standup');
  });

  it('tolerates empty / malformed responses', () => {
    expect(mapGoogleFreeBusy({})).toEqual([]);
    expect(mapOutlookView(null)).toEqual([]);
  });
});

describe('oauth calendar — token expiry', () => {
  it('flags an expired or about-to-expire token', () => {
    const now = 1_000_000;
    expect(tokenExpired(now + 5_000, now)).toBe(true);   // inside the skew window
    expect(tokenExpired(now + 600_000, now)).toBe(false); // 10 min out
    expect(tokenExpired(0, now)).toBe(true);              // never set
  });
});
