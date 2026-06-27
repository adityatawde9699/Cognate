/* Language picker (Act 5 i18n). Self-contained; switches the UI language
   instantly and persists the choice. */

import { useTranslation, LOCALES, type Locale } from '../../i18n';

export function LanguageSelect() {
  const { t, locale, setLocale } = useTranslation();
  return (
    <div className="settings-section">
      <h3>{t('settings.language')}</h3>
      <div className="form-group">
        <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
        <small className="form-hint">Applies across the app instantly.</small>
      </div>
    </div>
  );
}
