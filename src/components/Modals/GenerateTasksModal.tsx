import { useState } from 'react';
import { useStore } from '../../store';
import { generateTasks, NewTaskDraft } from '../../services/aiService';
import { addTask } from '../../services/taskService';
import { toast } from '../../utils/toast';

export function GenerateTasksModal() {
  const isOpen = useStore((s) => s.isGenerateModalOpen);
  const setOpen = useStore((s) => s.setGenerateModalOpen);

  const [desc, setDesc] = useState('');
  const [drafts, setDrafts] = useState<NewTaskDraft[]>([]);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  if (!isOpen) return null;

  const close = () => {
    setOpen(false);
    setDesc(''); setDrafts([]); setPicked([]);
  };

  const handleGenerate = async () => {
    if (!desc.trim()) { toast('⚠️ Describe a project first'); return; }
    setBusy(true);
    try {
      const result = await generateTasks(desc.trim());
      if (result.length === 0) { toast('No tasks generated — try more detail'); return; }
      setDrafts(result);
      setPicked(result.map(() => true));
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    const chosen = drafts.filter((_, i) => picked[i]);
    if (chosen.length === 0) { toast('Select at least one task'); return; }
    setCreating(true);
    try {
      for (const d of chosen) {
        await addTask({
          title: d.title,
          description: d.description,
          deadline: d.deadline,
          tags: d.tags,
          importance: d.importance,
          effort: d.effort,
        });
      }
      toast(`✅ Added ${chosen.length} task${chosen.length === 1 ? '' : 's'}`);
      close();
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const setTitle = (i: number, v: string) =>
    setDrafts((d) => d.map((t, idx) => (idx === i ? { ...t, title: v } : t)));
  const toggle = (i: number) =>
    setPicked((p) => p.map((v, idx) => (idx === i ? !v : v)));

  const selectedCount = picked.filter(Boolean).length;

  return (
    <div className="editor-overlay open" onClick={(e) => {
      if ((e.target as HTMLElement).className.includes('editor-overlay')) close();
    }}>
      <div className="editor-panel" role="dialog" aria-modal="true">
        <div className="editor-header">
          <span className="editor-prio-pill"><span className="p-dot" style={{ background: 'var(--accent)' }}></span> Generate tasks</span>
          <button className="btn-icon" onClick={close} aria-label="Close">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="editor-body">
          <label className="gen-label">Describe a project or goal</label>
          <textarea
            className="editor-desc"
            rows={4}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="e.g. Launch a personal portfolio site: design, build, write content, deploy…"
            autoFocus
          />
          <button className="btn-ai gen-run" disabled={busy} onClick={handleGenerate}>
            <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
            {drafts.length ? 'Regenerate' : 'Generate breakdown'}
          </button>

          {drafts.length > 0 && (
            <div className="gen-list">
              <div className="gen-list-hd">{selectedCount} of {drafts.length} selected</div>
              {drafts.map((d, i) => (
                <div key={i} className={`gen-row ${picked[i] ? 'on' : ''}`}>
                  <button className={`card-check ${picked[i] ? 'checked' : ''}`} onClick={() => toggle(i)}>
                    <i className="fa-solid fa-check"></i>
                  </button>
                  <div className="gen-row-main">
                    <input className="gen-title" value={d.title} onChange={(e) => setTitle(i, e.target.value)} />
                    <div className="gen-meta">
                      <span className={`p-badge ${['', 'low', 'medium', 'high'][Math.min(3, Math.ceil(d.importance / 2))]}`}>
                        <span className="p-dot"></span>imp {d.importance} · eff {d.effort}
                      </span>
                      {d.deadline && <span className="deadline-lbl"><i className="fa-regular fa-calendar"></i> {d.deadline}</span>}
                      {d.tags.map((t) => <span key={t} className="tag"><span className="tag-hash">#</span>{t}</span>)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="editor-footer">
          <button className="btn-ghost" onClick={close}>Cancel</button>
          {drafts.length > 0 && (
            <button className="btn-primary" disabled={creating || selectedCount === 0} onClick={handleCreate}>
              {creating ? 'Adding…' : `Add ${selectedCount} task${selectedCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
