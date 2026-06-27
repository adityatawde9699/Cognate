/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/components/TaskComments.tsx (Act 3)
   The per-task collaboration panel inside the task editor: assignee + threaded
   comments. Only appears when the task's project is shared. Writes go through
   the share's signed op-log; they propagate only if your roster role allows it.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect, useState } from 'react';
import type { Member } from '../services/collab';
import type { Comment } from '../services/collabProjection';
import {
  shareForProject, getComments, addComment, getRoster, getAssignee, setAssignee, type ShareMeta,
} from '../services/shareService';
import { toast } from '../utils/toast';

const short = (actor: string) => (actor ? actor.slice(0, 8) : 'unknown');

export function TaskComments({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const [share, setShare] = useState<ShareMeta | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [roster, setRoster] = useState<Member[]>([]);
  const [assignee, setAssigneeState] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (s: ShareMeta) => {
    setComments(await getComments(taskId));
    setRoster(await getRoster(s.id));
    setAssigneeState((await getAssignee(taskId)) ?? '');
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = projectId ? await shareForProject(projectId) : null;
      if (!alive) return;
      setShare(s);
      if (s) await load(s);
    })();
    return () => { alive = false; };
  }, [taskId, projectId]);

  if (!share) return null; // task isn't in a shared project — nothing to show

  const post = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await addComment(share.id, taskId, draft);
      setDraft('');
      await load(share);
    } catch (e: any) {
      toast(`⚠️ ${e?.message || 'Could not post comment'}`);
    } finally { setBusy(false); }
  };

  const assign = async (actor: string) => {
    setBusy(true);
    try {
      await setAssignee(share.id, taskId, actor);
      setAssigneeState(actor);
    } catch (e: any) {
      toast(`⚠️ ${e?.message || 'Could not assign'}`);
    } finally { setBusy(false); }
  };

  const labelCol = '130px 1fr';

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: '12px' }}>
      <div style={{ fontSize: '.68rem', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-d)', fontWeight: 600, padding: '4px 0 8px' }}>
        Collaboration · {share.name}
      </div>

      {/* Assignee */}
      <div style={{ display: 'grid', gridTemplateColumns: labelCol, alignItems: 'center', gap: '12px', padding: '7px 0' }}>
        <label style={{ color: 'var(--text-m)', fontSize: '.83rem' }}>
          <i className="fa-solid fa-user-check" style={{ marginRight: '8px', color: 'var(--text-d)' }}></i>Assignee
        </label>
        <select
          value={assignee}
          onChange={(e) => assign(e.target.value)}
          disabled={busy}
          style={{ padding: '9px 12px', fontSize: '.87rem', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box' }}
        >
          <option value="">Unassigned</option>
          {roster.map((m) => <option key={m.actor} value={m.actor}>{short(m.actor)} · {m.role}</option>)}
        </select>
      </div>

      {/* Comments */}
      <div style={{ padding: '7px 0' }}>
        <label style={{ color: 'var(--text-m)', fontSize: '.83rem', display: 'block', marginBottom: '8px' }}>
          <i className="fa-solid fa-comments" style={{ marginRight: '8px', color: 'var(--text-d)' }}></i>
          Comments {comments.length > 0 && <span style={{ color: 'var(--text-d)' }}>({comments.length})</span>}
        </label>

        {comments.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {comments.map((c) => (
              <li key={c.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '9px', padding: '8px 10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '.74rem', color: 'var(--accent)' }}>{short(c.author)}</span>
                  <span style={{ fontSize: '.7rem', color: 'var(--text-d)' }}>
                    {c.createdAt ? new Date(c.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
                <div style={{ fontSize: '.85rem', color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text" value={draft} placeholder="Write a comment…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void post(); } }}
            disabled={busy}
            style={{ flex: 1, padding: '9px 12px', fontSize: '.87rem', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: '9px', outline: 'none', boxSizing: 'border-box' }}
          />
          <button type="button" className="btn-soft" onClick={post} disabled={busy || !draft.trim()} style={{ flexShrink: 0 }}>
            <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`}></i>
          </button>
        </div>
      </div>
    </div>
  );
}
