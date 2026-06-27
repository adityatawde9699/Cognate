/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/i18n.ts — tiny, dependency-free internationalization (Act 5)
   ──────────────────────────────────────────────────────
   A pure translate() + a minimal reactive store (no i18next, no bundle cost):
   look a key up in the active locale, fall back to English, interpolate
   {params}. `useTranslation()` re-renders on a language change; the locale is
   persisted in settings and auto-detected from the browser on first run. The
   pure pieces (translate / detectLocale / interpolation) are unit-tested.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useSyncExternalStore } from 'react';
import { getSetting, setSetting } from './db';

export type Locale = 'en' | 'es' | 'de' | 'fr';
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
];

type Dict = Record<string, string>;

const en: Dict = {
  'onboarding.welcome': 'Welcome',
  'onboarding.title': 'Your day, planned in 60 seconds',
  'onboarding.body': 'Cognate lays out your day as time blocks — calendar- and energy-aware, re-planning itself when things move. It’s local-first and private: your data stays on your device, and the AI can run on a local model.',
  'onboarding.pasteLabel': 'Paste a calendar (.ics) to plan around your meetings — optional',
  'onboarding.plan': 'Plan my day',
  'onboarding.skip': 'Skip for now',
  'cmd.newTask': 'New task',
  'cmd.generate': 'Generate tasks with AI',
  'cmd.focus': 'Enter focus mode',
  'cmd.insights': 'Open Insights',
  'cmd.settings': 'Open Settings',
  'cmd.theme': 'Toggle theme',
  'cmd.addTask': 'Add task: {title}',
  'settings.language': 'Language',
  'common.cancel': 'Cancel',
  'common.save': 'Save changes',
};

// Translations carry only the keys that differ; missing ones fall back to en.
const es: Dict = {
  'onboarding.welcome': 'Bienvenido',
  'onboarding.title': 'Tu día, planificado en 60 segundos',
  'onboarding.body': 'Cognate organiza tu día en bloques de tiempo — consciente de tu calendario y tu energía, replanificándose cuando algo cambia. Es local y privado: tus datos permanecen en tu dispositivo y la IA puede ejecutarse en un modelo local.',
  'onboarding.pasteLabel': 'Pega un calendario (.ics) para planificar alrededor de tus reuniones — opcional',
  'onboarding.plan': 'Planificar mi día',
  'onboarding.skip': 'Omitir por ahora',
  'cmd.newTask': 'Nueva tarea',
  'cmd.generate': 'Generar tareas con IA',
  'cmd.focus': 'Entrar en modo concentración',
  'cmd.insights': 'Abrir Estadísticas',
  'cmd.settings': 'Abrir Ajustes',
  'cmd.theme': 'Cambiar tema',
  'cmd.addTask': 'Añadir tarea: {title}',
  'settings.language': 'Idioma',
  'common.cancel': 'Cancelar',
  'common.save': 'Guardar cambios',
};

const de: Dict = {
  'onboarding.welcome': 'Willkommen',
  'onboarding.title': 'Dein Tag, in 60 Sekunden geplant',
  'onboarding.plan': 'Meinen Tag planen',
  'onboarding.skip': 'Vorerst überspringen',
  'cmd.newTask': 'Neue Aufgabe',
  'cmd.settings': 'Einstellungen öffnen',
  'cmd.addTask': 'Aufgabe hinzufügen: {title}',
  'settings.language': 'Sprache',
};

const fr: Dict = {
  'onboarding.welcome': 'Bienvenue',
  'onboarding.title': 'Votre journée, planifiée en 60 secondes',
  'onboarding.plan': 'Planifier ma journée',
  'onboarding.skip': 'Passer pour l’instant',
  'cmd.newTask': 'Nouvelle tâche',
  'cmd.settings': 'Ouvrir les Réglages',
  'cmd.addTask': 'Ajouter une tâche : {title}',
  'settings.language': 'Langue',
};

export const DICT: Record<Locale, Dict> = { en, es, de, fr };

// ── Pure core ────────────────────────────────────────────

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

/** Resolve a key in `locale`, falling back to English, then the key itself. */
export function translate(
  dict: Record<string, Dict>,
  locale: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const table = dict[locale] ?? {};
  const raw = table[key] ?? dict.en?.[key] ?? key;
  return interpolate(raw, params);
}

/** Best available locale for the browser's preferences (base-language match). */
export function detectLocale(preferred: readonly string[], available: readonly string[]): string {
  for (const p of preferred) {
    const base = p.toLowerCase().split('-')[0];
    const hit = available.find((a) => a.toLowerCase() === base);
    if (hit) return hit;
  }
  return 'en';
}

// ── Reactive store (no dependency) ───────────────────────

const AVAILABLE = LOCALES.map((l) => l.code);
let current: Locale = 'en';
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}
function setLocaleLocal(l: Locale) {
  current = l;
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Change the language and persist it. */
export async function setLocale(l: Locale): Promise<void> {
  setLocaleLocal(l);
  await setSetting('locale', l);
}

/** Load the saved locale, or detect from the browser, at startup. */
export async function initLocale(): Promise<void> {
  const saved = (await getSetting('locale', '')) as Locale | '';
  if (saved && AVAILABLE.includes(saved)) {
    setLocaleLocal(saved);
    return;
  }
  const langs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  setLocaleLocal(detectLocale(langs, AVAILABLE) as Locale);
}

/** Non-reactive translate against the active locale (for non-React callers). */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(DICT, current, key, params);
}

/** React hook: re-renders on a language change. */
export function useTranslation() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return {
    locale,
    setLocale,
    t: (key: string, params?: Record<string, string | number>) => translate(DICT, locale, key, params),
  };
}

/** Test seam. */
export function _resetForTests(): void {
  current = 'en';
  listeners.clear();
}
