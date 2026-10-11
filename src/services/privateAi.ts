/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/privateAi.ts — one-click private auto-planning (Act 4)
   ──────────────────────────────────────────────────────
   The headline demo: a single toggle that points the AI layer at a LOCAL model
   (Ollama) so estimation, advice, and quick-add enrichment all run on-device —
   nothing leaves the machine. Just curated defaults over the existing
   multi-provider `generate()`; no new model code.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting } from '../db';

export const OLLAMA_BASE = 'http://localhost:11434/v1';
export const DEFAULT_LOCAL_MODEL = 'llama3.1';

export interface AiPreset { provider: string; baseUrl: string; model: string }

export function aiEndpoint(provider: string, baseUrl: string): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  const defaults: Record<string, string> = { openai: 'https://api.openai.com/v1', openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1', xai: 'https://api.x.ai/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', deepseek: 'https://api.deepseek.com/v1', ollama: OLLAMA_BASE, llamacpp: 'http://localhost:8080/v1' };
  const effective = baseUrl.trim() || defaults[provider] || '';
  const url = new URL(effective);
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error('AI endpoints require HTTPS or loopback HTTP without credentials, query or fragment.');
  return effective.replace(/\/$/, '');
}

/** The settings a one-click "go private" applies. Pure. */
export function privateAiPreset(model = DEFAULT_LOCAL_MODEL): AiPreset {
  return { provider: 'ollama', baseUrl: OLLAMA_BASE, model };
}

/** True when a provider/base pair keeps inference on-device. Pure. */
export function isLocalProvider(provider: string, baseUrl: string): boolean {
  if (provider === 'anthropic') return false;
  const effective = baseUrl.trim() || (provider==='ollama' ? OLLAMA_BASE : provider==='llamacpp' ? 'http://localhost:8080/v1' : '');
  try {
    const url = new URL(effective);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash &&
      (url.hostname==='localhost' || url.hostname==='[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname));
  } catch { return false; }
}

/** Point the AI layer at a local model. Returns the applied preset. */
export async function enablePrivateAi(model = DEFAULT_LOCAL_MODEL): Promise<AiPreset> {
  const p = privateAiPreset(model);
  await setSetting('ai_provider', p.provider);
  await setSetting('ai_base_url', p.baseUrl);
  await setSetting('ai_model', p.model);
  window.dispatchEvent(new CustomEvent('settings-changed'));
  return p;
}

/** Is the AI layer currently running fully on-device? */
export async function isPrivateAiActive(): Promise<boolean> {
  const provider = (await getSetting('ai_provider', 'anthropic')) || 'anthropic';
  const baseUrl = (await getSetting('ai_base_url', '')) || '';
  return isLocalProvider(provider, baseUrl);
}

/** Best-effort reachability check of a local model server (lists models). */
export async function checkLocalAi(baseUrl = OLLAMA_BASE): Promise<boolean> {
  if (!isLocalProvider('custom', baseUrl)) return false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: abort.signal, redirect: 'error' });
    return r.ok;
  } catch {
    return false;
  } finally { clearTimeout(timeout); }
}
