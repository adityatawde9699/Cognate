import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './style.css';
import App from './App';
import { migrateSecrets } from './utils/secrets';
import { registerServiceWorker } from './utils/pwa';
import { initLocale } from './i18n';

// Move any legacy plaintext secrets into the OS keychain (desktop only).
void migrateSecrets();

// Load the saved/auto-detected UI language (components re-render when ready).
void initLocale();

// Make the web build installable + offline-capable (no-op on desktop/dev).
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
