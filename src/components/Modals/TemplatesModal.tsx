import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useVisibleTasks } from '../../hooks/useVisibleTasks';
import { getTemplates, saveTemplate, applyTemplate, removeTemplate, Template } from '../../services/templateService';
import { toast } from '../../utils/toast';

export function TemplatesModal() {
  const mode = useStore((s) => s.templatesMode);
  const setMode = useStore((s) => s.setTemplatesMode);
  const projects = useStore((s) => s.projects);
  const visible = useVisibleTasks();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [applyProject, setApplyProject] = useState('');

  const saveTasks = visible.filter((t) => !t.parent_id);

  useEffect(() => {
    if (mode === 'apply') getTemplates().then(setTemplates);
    if (mode) { setName(''); setApplyProject(''); }
  }, [mode]);

  if (!mode) return null;
  const close = () => setMode(null);

  const handleSave = async () => {
    if (!name.trim()) { toast('⚠️ Name your template'); return; }
    if (saveTasks.length === 0) { toast('No tasks here to save'); return; }
    setBusy(true);
    try {
      await saveTemplate(name.trim(), saveTasks);
      toast(`✅ Saved template “${name.trim()}”`);
      close();
    } finally { setBusy(false); }
  };

  const handleApply = async (tpl: Template) => {
    setBusy(true);
    try {
      const n = await applyTemplate(tpl, applyProject || null);
      toast(`✅ Added ${n} task${n === 1 ? '' : 's'} from “${tpl.name}”`);
      close();
    } finally { setBusy(false); }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await removeTemplate(id);
    setTemplates(await getTemplates());
  };

  return (
    <div className="editor-overlay open" onClick={(e) => { if ((e.target as HTMLElement).className.includes('editor-overlay')) close(); }}>
      <div className="editor-panel" role="dialog" aria-modal="true">
        <div className="editor-header">
          <span className="editor-kicker">{mode === 'save' ? 'Save as template' : 'New from template'}</span>
          <button className="btn-icon" onClick={close} aria-label="Close"><i className="fa-solid fa-xmark"></i></button>
        </div>

        <div className="editor-body">
          {mode === 'save' ? (
            <>
              <div className="editor-field">
                <span className="field-label">Template name</span>
                <input className="editor-title" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Client onboarding" autoFocus />
              </div>
              <p className="tpl-hint">Saves <strong>{saveTasks.length}</strong> task{saveTasks.length === 1 ? '' : 's'} from the current view. Deadlines are kept as relative offsets.</p>
            </>
          ) : (
            <>
              <div className="editor-field">
                <span className="field-label">Add into project (optional)</span>
                <select value={applyProject} onChange={(e) => setApplyProject(e.target.value)}>
                  <option value="">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="tpl-list">
                {templates.length === 0 && <p className="proj-empty">No templates yet — save one from any view.</p>}
                {templates.map((t) => (
                  <div key={t.id} className="tpl-item">
                    <div className="tpl-info">
                      <span className="tpl-name">{t.name}</span>
                      <span className="tpl-meta">{t.data?.tasks?.length ?? 0} tasks</span>
                    </div>
                    <button className="btn-soft" disabled={busy} onClick={() => handleApply(t)}>Use</button>
                    <button className="icon-btn del" onClick={(e) => handleDelete(e, t.id)} title="Delete"><i className="fa-solid fa-trash-can"></i></button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {mode === 'save' && (
          <div className="editor-footer">
            <button className="btn-ghost" onClick={close}>Cancel</button>
            <button className="btn-primary" disabled={busy} onClick={handleSave}>Save template</button>
          </div>
        )}
      </div>
    </div>
  );
}
