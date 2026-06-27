/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/components/Onboarding.tsx (Act 5)
   The 60-second first run: a welcome, an optional calendar paste, and one
   button that plans your day. Self-gating (renders nothing once onboarded).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useTranslation } from '../i18n';
import { isOnboarded, markOnboarded, quickStart } from '../services/onboardingService';
import { loadAllTasks } from '../services/taskService';
import { toast } from '../utils/toast';

export function Onboarding() {
  const setFilter = useStore((s) => s.setFilter);
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [ics, setIcs] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { isOnboarded().then((done) => setShow(!done)); }, []);
  if (!show) return null;

  const finish = async () => {
    setBusy(true);
    try {
      const r = await quickStart({ icsText: ics, addStarters: true });
      await loadAllTasks('all');
      setFilter('plan');
      setShow(false);
      toast(`✨ Your day is planned — ${r.planned} block${r.planned === 1 ? '' : 's'}${r.busy ? `, ${r.busy} from your calendar` : ''}`);
    } catch {
      toast('Could not plan your day — you can Auto-plan anytime.');
      setShow(false);
    } finally { setBusy(false); }
  };

  const skip = async () => { await markOnboarded(); setShow(false); };

  const card: React.CSSProperties = {
    width: 'min(560px, 92vw)', background: 'var(--bg-1)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-l, 16px)', padding: '28px', boxShadow: 'var(--shadow-lg)',
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Welcome to Cognate" style={{
      position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center',
      background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
    }}>
      <div style={card}>
        <div style={{ fontSize: '.72rem', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700 }}>
          {t('onboarding.welcome')}
        </div>
        <h1 style={{ margin: '6px 0 8px', fontSize: '1.5rem', color: 'var(--text)' }}>{t('onboarding.title')}</h1>
        <p style={{ color: 'var(--text-m)', fontSize: '.92rem', lineHeight: 1.5, margin: 0 }}>
          {t('onboarding.body')}
        </p>

        <label style={{ display: 'block', margin: '18px 0 6px', color: 'var(--text-m)', fontSize: '.85rem' }}>
          <i className="fa-regular fa-calendar" style={{ marginRight: '8px' }}></i>
          {t('onboarding.pasteLabel')}
        </label>
        <textarea
          value={ics} onChange={(e) => setIcs(e.target.value)} rows={4}
          placeholder="BEGIN:VCALENDAR …  (or skip — you can connect a calendar later in Settings)"
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '10px 12px',
            fontSize: '.82rem', fontFamily: 'var(--font-mono, monospace)', color: 'var(--text)',
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-s)',
          }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
          <button className="btn-ghost" onClick={skip} disabled={busy}>{t('onboarding.skip')}</button>
          <button className="btn-primary" onClick={finish} disabled={busy}>
            <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>{' '}
            {t('onboarding.plan')}
          </button>
        </div>
      </div>
    </div>
  );
}
