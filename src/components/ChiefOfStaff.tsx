/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/components/ChiefOfStaff.tsx (Act 4)
   The proactive banner atop the Plan: a one-line morning brief, plus an
   overcommitment nudge with the least-important work to move. Facts are
   deterministic (chiefOfStaff service) so the advice is trustworthy + offline.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { getWorkHours } from '../services/planService';
import { morningBrief, detectOvercommit } from '../services/chiefOfStaff';

export function ChiefOfStaff({ date }: { date: string }) {
  const tasks = useStore((s) => s.currentTasks);
  const [work, setWork] = useState({ start: 9 * 60, end: 17 * 60 });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => { getWorkHours().then(setWork); }, []);
  useEffect(() => { setDismissed(false); }, [date]);

  const brief = useMemo(() => morningBrief(tasks, new Date(`${date}T09:00:00`)), [tasks, date]);
  const over = useMemo(() => detectOvercommit(tasks, work, date), [tasks, work, date]);

  if (dismissed) return null;

  const hrs = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${(m / 60).toFixed(1)}h`);

  return (
    <div className="cos-banner" role="status" style={{
      display: 'flex', alignItems: 'flex-start', gap: '10px', margin: '0 0 12px',
      padding: '10px 14px', borderRadius: 'var(--radius)', background: 'var(--surface)',
      border: `1px solid ${over.isOvercommitted ? 'var(--danger)' : 'var(--border)'}`,
    }}>
      <i className={`fa-solid ${over.isOvercommitted ? 'fa-triangle-exclamation' : 'fa-mug-hot'}`}
         style={{ color: over.isOvercommitted ? 'var(--danger)' : 'var(--accent)', marginTop: '2px' }}></i>
      <div style={{ flex: 1, fontSize: '.85rem', color: 'var(--text-m)' }}>
        <strong style={{ color: 'var(--text)' }}>{brief.headline}</strong>
        {over.isOvercommitted && (
          <div style={{ marginTop: '4px', color: 'var(--danger)' }}>
            Overcommitted by {hrs(over.overBy)} — consider moving{' '}
            {over.suggestions.slice(0, 2).map((t) => `“${t.title}”`).join(' and ')}.
          </div>
        )}
      </div>
      <button className="plan-note-x" onClick={() => setDismissed(true)} aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: 'var(--text-d)', cursor: 'pointer' }}>
        <i className="fa-solid fa-xmark"></i>
      </button>
    </div>
  );
}
