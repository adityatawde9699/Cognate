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

/** The settings a one-click "go private" applies. Pure. */
export function privateAiPreset(model = DEFAULT_LOCAL_MODEL): AiPreset {
  return { provider: 'ollama', baseUrl: OLLAMA_BASE, model };
}

/** True when a provider/base pair keeps inference on-device. Pure. */
export function isLocalProvider(provider: string, baseUrl: string): boolean {
  if (provider === 'ollama' || provider === 'llamacpp') return true;
  return /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b/.test(baseUrl || '');
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
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/models`);
    return r.ok;
  } catch {
    return false;
  }
}
