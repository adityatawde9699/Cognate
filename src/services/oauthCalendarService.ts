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

import {invoke} from '@tauri-apps/api/core';
import { IS_TAURI, setSetting, clearCalendarSource, replaceCalendarSource } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { calendarMetadata, type BusyEvent } from './calendarSyncService';

export type CalProvider = 'google' | 'microsoft';
export const OAUTH_SOURCE = 'oauth';
export const REDIRECT_URI = 'http://127.0.0.1:8788/callback'; // loopback (PKCE, no secret)

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
      if (b?.start && b?.end) out.push({ title: 'Busy', start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() });
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
      out.push({ title: ev?.subject || 'Busy', start: new Date(/Z$|[+-]\d{2}:\d{2}$/.test(start) ? start : `${start}Z`).toISOString(), end: new Date(/Z$|[+-]\d{2}:\d{2}$/.test(end) ? end : `${end}Z`).toISOString() });
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
  let tokens:TokenSet;
  try {tokens=JSON.parse(raw);}catch{throw new Error('Stored calendar credentials are invalid. Reconnect your calendar.');}
  if(!tokens || !Object.prototype.hasOwnProperty.call(CAL_PROVIDERS,tokens.provider) || typeof tokens.clientId!=='string' || !tokens.clientId || typeof tokens.access!=='string' || !tokens.access || typeof tokens.refresh!=='string' || !Number.isFinite(tokens.expiresAt)) throw new Error('Stored calendar credentials are invalid. Reconnect your calendar.');
  return tokens;
}
async function saveTokens(t: TokenSet): Promise<void> { await setSecret(TOKENS_SECRET, JSON.stringify(t)); }

export async function isCalendarConnected(): Promise<boolean> { return (await loadTokens()) !== null; }
export async function disconnectCalendar(): Promise<void> {
  await cancelConnect();
  await setSecret(TOKENS_SECRET, '');
  await clearCalendarSource(OAUTH_SOURCE);
  await setSetting('calendar_meta:oauth','');
}

// ── Rust transport (desktop only) ────────────────────────

async function rustToken(tokenUrl: string, form: Record<string, string>): Promise<any> {
  return JSON.parse(await invoke<string>('oauth_token', { tokenUrl, form }));
}
async function rustApi(method: 'GET' | 'POST', url: string, token: string, body: string): Promise<any> {
  return JSON.parse(await invoke<string>('oauth_api', { method, url, token, body }));
}

// ── Connect flow ─────────────────────────────────────────

/** Step 1: stash PKCE state and return the URL to open in a browser. */
let connectGeneration=0;
export async function beginConnect(provider: CalProvider, clientId: string): Promise<string> {
  if (!IS_TAURI) throw new Error('Calendar sign-in needs the desktop app.');
  if (!clientId.trim()) throw new Error('Enter your OAuth client id first.');
  connectGeneration++;
  const verifier = generateVerifier();
  const challenge = await challengeFromVerifier(verifier);
  const state = generateVerifier();
  await invoke('start_oauth',{state});
  await setSecret(PENDING_KEY, JSON.stringify({ provider, clientId: clientId.trim(), verifier, state, createdAt:Date.now() }));
  return buildAuthUrl(provider, clientId.trim(), challenge, state);
}

/** Validate the entire redirect, not a bare code that loses OAuth state. */
export function validateCalendarRedirect(redirect: string, expectedState: string, createdAt: number, now=Date.now()): string {
  if (!Number.isFinite(createdAt) || now<createdAt || now-createdAt>10*60*1000) throw new Error('Calendar sign-in expired. Start again.');
  const url = new URL(redirect.trim());
  const target = new URL(REDIRECT_URI);
  if (url.origin!==target.origin || url.pathname!==target.pathname || url.username || url.password || url.hash) throw new Error('Unexpected calendar callback URL.');
  if (url.searchParams.getAll('state').length!==1 || url.searchParams.get('state')!==expectedState) throw new Error('Calendar sign-in state did not match. Start again.');
  if (url.searchParams.has('error')) throw new Error('Calendar access was not approved.');
  const codes = url.searchParams.getAll('code');
  if (codes.length!==1 || !codes[0]) throw new Error('Calendar callback is missing its authorization code.');
  return codes[0];
}
/** Step 2: exchange a verified redirect for tokens. */
let exchangeRunning=false;
export async function completeConnect(redirect:string):Promise<void> {
  if(exchangeRunning) throw new Error('Calendar callback is already being exchanged.');
  exchangeRunning=true;
  try {await exchangeCallback(redirect);}finally{exchangeRunning=false;}
}
async function exchangeCallback(redirect: string): Promise<void> {
  const pendingRaw = await getSecret(PENDING_KEY);
  if (!pendingRaw) throw new Error('No sign-in in progress. Start again.');
  const { provider, clientId, verifier, state, createdAt } = JSON.parse(pendingRaw);
  const code = validateCalendarRedirect(redirect,state,createdAt);
  if (!Object.prototype.hasOwnProperty.call(CAL_PROVIDERS,provider)) throw new Error('Invalid pending calendar provider.');
  // Consume before sending: callbacks cannot replay a code exchange.
  await cancelConnect();
  const generation=connectGeneration;
  const p = CAL_PROVIDERS[provider as CalProvider];
  const tok = await rustToken(p.tokenUrl, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  if(generation!==connectGeneration) throw new Error('Calendar sign-in was cancelled or replaced.');
  if (!tok.access_token) throw new Error('Token exchange failed (no access token returned).');
  await saveTokens({
    provider, clientId,
    access: tok.access_token,
    refresh: tok.refresh_token ?? '',
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
  });
  await setSecret(PENDING_KEY, '');
}

export async function cancelConnect():Promise<void> {
  connectGeneration++;
  await setSecret(PENDING_KEY,'');
  if(IS_TAURI) await invoke('cancel_oauth');
}
let refreshPending:Promise<TokenSet>|null=null;
async function freshAccessToken():Promise<TokenSet> {
  if(refreshPending) return refreshPending;
  refreshPending=refreshAccessToken();
  try{return await refreshPending;}finally{refreshPending=null;}
}
async function refreshAccessToken(): Promise<TokenSet> {
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
  const current=await loadTokens();
  if(!current || JSON.stringify(current)!==JSON.stringify(t)) throw new Error('Calendar connection changed during refresh.');
  await saveTokens(next);
  return next;
}

/** Pull the next `days` of busy time from the connected account into the planner. */
export async function syncFreeBusy(days = 7,startDate?:Date): Promise<number> {
  const t = await freshAccessToken();
  if(!Number.isInteger(days) || days<1 || days>180) throw new Error('Calendar horizon must be 1–180 days.');
  const now = startDate ?? new Date(new Date().setHours(0,0,0,0));
  const end = new Date(now.getTime() + days * 86_400_000);
  let events: BusyEvent[];

  if (t.provider === 'google') {
    const json = await rustApi('POST', 'https://www.googleapis.com/calendar/v3/freeBusy', t.access,
      JSON.stringify({ timeMin: now.toISOString(), timeMax: end.toISOString(), items: [{ id: 'primary' }] }));
    if(!json?.calendars?.primary || !Array.isArray(json.calendars.primary.busy)) throw new Error('Incomplete Google availability response. Previous busy blocks retained.');
    if(Object.values(json?.calendars ?? {}).some(cal=>(cal as any)?.errors?.length)) throw new Error('Calendar provider could not return complete availability. Previous busy blocks retained.');
    events = mapGoogleFreeBusy(json);
  } else {
    const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,showAs&$top=200`;
    let next:string|null=url; events=[]; let pages=0;
    while(next) {
      if(++pages>50) throw new Error('Calendar pagination limit exceeded. Previous busy blocks retained.');
      const json=await rustApi('GET',next,t.access,'');
      if(!Array.isArray(json?.value)) throw new Error('Incomplete Outlook availability response. Previous busy blocks retained.');
      events.push(...mapOutlookView(json));
      next=json['@odata.nextLink'] ?? null;
      if(next && (new URL(next).origin!=='https://graph.microsoft.com' || new URL(next).pathname!=='/v1.0/me/calendarView')) throw new Error('Unexpected calendar pagination URL.');
    }
  }

  const current=await loadTokens();
  if(!current || current.provider!==t.provider || current.clientId!==t.clientId || current.refresh!==t.refresh) throw new Error('Calendar disconnected or replaced during refresh.');
  await replaceCalendarSource(OAUTH_SOURCE, events,calendarMetadata({start:now,end},'oauth'));
  return events.length;
}

export function startCalendarRefresh():()=>void {
  if(!IS_TAURI) return ()=>{};
  let stopped=false,running=false;
  const tick=async()=>{
    if(stopped || running || document.visibilityState==='hidden')return;
    running=true;
    try {if(await isCalendarConnected()) await syncFreeBusy(14);}catch(error){console.warn('[calendar] refresh failed; previous busy blocks retained',error);}finally{running=false;}
  };
  const initial=setTimeout(tick,15000),timer=setInterval(tick,15*60*1000);
  const visible=()=>{if(document.visibilityState==='visible')void tick();};
  document.addEventListener('visibilitychange',visible);
  return ()=>{stopped=true;clearTimeout(initial);clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
}
