import { describe, it, expect } from 'vitest';
import { translate, interpolate, detectLocale, DICT } from './i18n';

describe('i18n — interpolation', () => {
  it('fills named params and leaves unknowns visible', () => {
    expect(interpolate('Add task: {title}', { title: 'Call Sam' })).toBe('Add task: Call Sam');
    expect(interpolate('plain')).toBe('plain');
    expect(interpolate('hi {who}', {})).toBe('hi {who}');
  });
});

describe('i18n — translate with fallback', () => {
  it('returns the locale string when present', () => {
    expect(translate(DICT, 'es', 'onboarding.plan')).toBe('Planificar mi día');
  });
  it('falls back to English for an untranslated key', () => {
    // 'common.cancel' is not in the German table → English.
    expect(translate(DICT, 'de', 'common.cancel')).toBe('Cancel');
  });
  it('falls back to the key itself when unknown everywhere', () => {
    expect(translate(DICT, 'en', 'nope.missing')).toBe('nope.missing');
  });
  it('interpolates within the chosen locale', () => {
    expect(translate(DICT, 'es', 'cmd.addTask', { title: 'X' })).toBe('Añadir tarea: X');
  });
});

describe('i18n — detectLocale', () => {
  const available = ['en', 'es', 'de', 'fr'];
  it('matches on base language', () => {
    expect(detectLocale(['es-MX', 'en-US'], available)).toBe('es');
    expect(detectLocale(['fr-CA'], available)).toBe('fr');
  });
  it('falls through to the first match in preference order', () => {
    expect(detectLocale(['pt-BR', 'de-AT'], available)).toBe('de');
  });
  it('defaults to English when nothing matches', () => {
    expect(detectLocale(['ja', 'ko'], available)).toBe('en');
    expect(detectLocale([], available)).toBe('en');
  });
});
