/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/oauthCalendarService.ts — live free/busy via OAuth (Act 1)
   ──────────────────────────────────────────────────────
   Completes the calendar bullet: after the `.ics` path, read-only Google /
   Outlook free-busy over OAuth 2.0 with PKCE. Tokens live in the OS keychain;
   refresh is automatic. Desktop-only (the token + API calls go through Rust —
   browsers can't reach these endpoints cross-origin). The pure pieces here
   (PKCE, the auth URL, the free/busy → busy-block mappers, expiry) are unit-
   tested; only the live handshake needs your own OAuth client id + provider
   approval (an external step the plan calls out).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { IS_TAURI, getSetting, setSetting, clearCalendarSource, createCalendarEvent } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import type { BusyEvent } from './calendarSyncService';

export type CalProvider = 'google' | 'microsoft';
export const OAUTH_SOURCE = 'oauth';
const REDIRECT_URI = 'http://127.0.0.1:8788/callback'; // loopback (PKCE, no secret)

interface ProviderCfg {
  label: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
}
export const CAL_PROVIDERS: Record<CalProvider, ProviderCfg> = {
  google: {
    label: 'Google Calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.freebusy',
  },
  microsoft: {
    label: 'Outlook / Microsoft 365',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'Calendars.Read offline_access',
  },
};

// ── PKCE (pure) ──────────────────────────────────────────

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A high-entropy PKCE code verifier (RFC 7636: 43–128 url-safe chars). */
export function generateVerifier(): string {
  const bytes = (globalThis as any).crypto.getRandomValues(new Uint8Array(32));
  return b64url(bytes);
}

/** The S256 code challenge for a verifier. */
export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await (globalThis as any).crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Build the provider authorization URL for a PKCE flow. */
export function buildAuthUrl(
  provider: CalProvider,
  clientId: string,
  challenge: string,
  state: string,
  redirectUri = REDIRECT_URI
): string {
  const p = CAL_PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: p.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline', // Google: get a refresh token
    prompt: 'consent',
  });
  return `${p.authUrl}?${q.toString()}`;
}

// ── Free/busy mappers (pure) ─────────────────────────────

function pad(n: number): string { return String(n).padStart(2, '0'); }
/** A UTC ISO instant → local wall-clock ISO (matches the .ics path's format). */
export function utcIsoToLocal(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Google freeBusy response → busy blocks. `calendars[*].busy[] = {start,end}` (UTC ISO). */
export function mapGoogleFreeBusy(json: any): BusyEvent[] {
  const out: BusyEvent[] = [];
  const cals = json?.calendars ?? {};
  for (const id of Object.keys(cals)) {
    for (const b of cals[id]?.busy ?? []) {
      if (b?.start && b?.end) out.push({ title: 'Busy', start: utcIsoToLocal(b.start), end: utcIsoToLocal(b.end) });
    }
  }
  return out;
}

/** Microsoft Graph calendarView response → busy blocks. `value[] = {start:{dateTime}, end:{dateTime}, showAs}`. */
export function mapOutlookView(json: any): BusyEvent[] {
  const out: BusyEvent[] = [];
  for (const ev of json?.value ?? []) {
    const start = ev?.start?.dateTime;
    const end = ev?.end?.dateTime;
    const free = String(ev?.showAs ?? '').toLowerCase() === 'free';
    if (start && end && !free) {
      // Graph returns UTC when Prefer: outlook.timezone="UTC" is sent (we do).
      out.push({ title: ev?.subject || 'Busy', start: utcIsoToLocal(`${start}Z`), end: utcIsoToLocal(`${end}Z`) });
    }
  }
  return out;
}

/** Refresh ahead of real expiry to avoid mid-request 401s. */
export function tokenExpired(expiresAtMs: number, now = Date.now(), skewMs = 60_000): boolean {
  return !expiresAtMs || now + skewMs >= expiresAtMs;
}

// ── Token storage ────────────────────────────────────────

interface TokenSet {
  provider: CalProvider;
  clientId: string;
  access: string;
  refresh: string;
  expiresAt: number;
}
const TOKENS_SECRET = 'cal_oauth_tokens';
const PENDING_KEY = 'cal_oauth_pending';

async function loadTokens(): Promise<TokenSet | null> {
  const raw = await getSecret(TOKENS_SECRET);
  if (!raw) return null;
  try { return JSON.parse(raw) as TokenSet; } catch { return null; }
}
async function saveTokens(t: TokenSet): Promise<void> { await setSecret(TOKENS_SECRET, JSON.stringify(t)); }

export async function isCalendarConnected(): Promise<boolean> { return (await loadTokens()) !== null; }
export async function disconnectCalendar(): Promise<void> {
  await setSecret(TOKENS_SECRET, '');
  await clearCalendarSource(OAUTH_SOURCE);
}

// ── Rust transport (desktop only) ────────────────────────

async function rustToken(tokenUrl: string, form: Record<string, string>): Promise<any> {
  const { invoke } = await import('@tauri-apps/api/core');
  return JSON.parse(await invoke<string>('oauth_token', { tokenUrl, form }));
}
async function rustApi(method: 'GET' | 'POST', url: string, token: string, body: string): Promise<any> {
  const { invoke } = await import('@tauri-apps/api/core');
  return JSON.parse(await invoke<string>('oauth_api', { method, url, token, body }));
}

// ── Connect flow ─────────────────────────────────────────

/** Step 1: stash PKCE state and return the URL to open in a browser. */
export async function beginConnect(provider: CalProvider, clientId: string): Promise<string> {
  if (!IS_TAURI) throw new Error('Calendar sign-in needs the desktop app.');
  if (!clientId.trim()) throw new Error('Enter your OAuth client id first.');
  const verifier = generateVerifier();
  const challenge = await challengeFromVerifier(verifier);
  const state = generateVerifier().slice(0, 16);
  await setSetting(PENDING_KEY, JSON.stringify({ provider, clientId: clientId.trim(), verifier, state }));
  return buildAuthUrl(provider, clientId.trim(), challenge, state);
}

/** Step 2: exchange the authorization code (from the redirect) for tokens. */
export async function completeConnect(code: string): Promise<void> {
  const pendingRaw = await getSetting(PENDING_KEY, '');
  if (!pendingRaw) throw new Error('No sign-in in progress. Start again.');
  const { provider, clientId, verifier } = JSON.parse(pendingRaw);
  const p = CAL_PROVIDERS[provider as CalProvider];
  const tok = await rustToken(p.tokenUrl, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code: code.trim(),
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  if (!tok.access_token) throw new Error('Token exchange failed (no access token returned).');
  await saveTokens({
    provider, clientId,
    access: tok.access_token,
    refresh: tok.refresh_token ?? '',
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
  });
  await setSetting(PENDING_KEY, '');
}

async function freshAccessToken(): Promise<TokenSet> {
  const t = await loadTokens();
  if (!t) throw new Error('No calendar account connected.');
  if (!tokenExpired(t.expiresAt)) return t;
  if (!t.refresh) throw new Error('Session expired — reconnect your calendar.');
  const p = CAL_PROVIDERS[t.provider];
  const r = await rustToken(p.tokenUrl, {
    client_id: t.clientId,
    grant_type: 'refresh_token',
    refresh_token: t.refresh,
  });
  if (!r.access_token) throw new Error('Could not refresh the calendar session.');
  const next: TokenSet = {
    ...t,
    access: r.access_token,
    refresh: r.refresh_token ?? t.refresh,
    expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000,
  };
  await saveTokens(next);
  return next;
}

/** Pull the next `days` of busy time from the connected account into the planner. */
export async function syncFreeBusy(days = 7): Promise<number> {
  const t = await freshAccessToken();
  const now = new Date();
  const end = new Date(now.getTime() + days * 86_400_000);
  let events: BusyEvent[];

  if (t.provider === 'google') {
    const json = await rustApi('POST', 'https://www.googleapis.com/calendar/v3/freeBusy', t.access,
      JSON.stringify({ timeMin: now.toISOString(), timeMax: end.toISOString(), items: [{ id: 'primary' }] }));
    events = mapGoogleFreeBusy(json);
  } else {
    const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,showAs&$top=200`;
    const json = await rustApi('GET', url, t.access, '');
    events = mapOutlookView(json);
  }

  await clearCalendarSource(OAUTH_SOURCE);
  for (const e of events) await createCalendarEvent({ title: e.title, start: e.start, end: e.end, source: OAUTH_SOURCE });
  return events.length;
}
