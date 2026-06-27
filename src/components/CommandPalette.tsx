import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useTheme } from '../hooks/useTheme';
import { parseQuickAdd, quickAddPreview } from '../services/nlQuickAdd';
import { quickAdd } from '../services/quickAddService';
import { useTranslation } from '../i18n';
import { toast } from '../utils/toast';

interface Cmd { id: string; label: string; icon: string; hint?: string; run: () => void; }

export function CommandPalette() {
  const isOpen = useStore((s) => s.isCommandOpen);
  const setOpen = useStore((s) => s.setCommandOpen);
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);
  const setGenerateModalOpen = useStore((s) => s.setGenerateModalOpen);
  const setAnalyticsOpen = useStore((s) => s.setAnalyticsOpen);
  const setSettingsModalOpen = useStore((s) => s.setSettingsModalOpen);
  const setFilter = useStore((s) => s.setFilter);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const setTemplatesMode = useStore((s) => s.setTemplatesMode);
  const tasks = useStore((s) => s.currentTasks);
  const { toggleTheme } = useTheme();
  const { t, locale } = useTranslation();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) { setQuery(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [isOpen]);

  const close = () => setOpen(false);
  const act = (fn: () => void) => { close(); fn(); };

  const actions: Cmd[] = useMemo(() => [
    { id: 'new', label: t('cmd.newTask'), icon: 'fa-plus', hint: 'N', run: () => setTaskModalOpen(true) },
    { id: 'gen', label: t('cmd.generate'), icon: 'fa-wand-magic-sparkles', run: () => setGenerateModalOpen(true) },
    { id: 'tpl-new', label: 'New from template', icon: 'fa-copy', run: () => setTemplatesMode('apply') },
    { id: 'tpl-save', label: 'Save current view as template', icon: 'fa-bookmark', run: () => setTemplatesMode('save') },
    { id: 'focus', label: t('cmd.focus'), icon: 'fa-bullseye', run: () => setFocusMode(true) },
    { id: 'insights', label: t('cmd.insights'), icon: 'fa-chart-pie', run: () => setAnalyticsOpen(true) },
    { id: 'settings', label: t('cmd.settings'), icon: 'fa-gear', run: () => setSettingsModalOpen(true) },
    { id: 'theme', label: t('cmd.theme'), icon: 'fa-circle-half-stroke', hint: 'T', run: () => toggleTheme() },
    { id: 'go-dash', label: 'Go to Dashboard', icon: 'fa-table-columns', run: () => setFilter('dashboard') },
    { id: 'go-all', label: 'Go to Tasks', icon: 'fa-inbox', run: () => setFilter('all') },
    { id: 'go-today', label: 'Go to Today', icon: 'fa-sun', run: () => setFilter('today') },
    { id: 'go-week', label: 'Go to This Week', icon: 'fa-calendar-week', run: () => setFilter('week') },
    { id: 'go-high', label: 'Go to Flagged', icon: 'fa-flag', run: () => setFilter('high') },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [locale]);

  const items: Cmd[] = useMemo(() => {
    const raw = query.trim();
    const q = raw.toLowerCase();
    const matchedActions = q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
    const taskItems: Cmd[] = (q
      ? tasks.filter((t) => t.title.toLowerCase().includes(q))
      : tasks.filter((t) => !t.done)
    ).slice(0, 6).map((t) => ({
      id: `task-${t.id}`,
      label: t.title,
      icon: t.done ? 'fa-circle-check' : 'fa-circle',
      hint: 'open',
      run: () => setTaskModalOpen(true, t),
    }));
    const list = [...matchedActions, ...taskItems];
    if (!raw) return list;

    // Natural-language quick-add: "call Sam tmrw 5pm 30m #work" → a scheduled task.
    const parsed = parseQuickAdd(raw);
    if (!parsed.title) return list;
    const quickItem: Cmd = {
      id: 'quick-add',
      label: t('cmd.addTask', { title: parsed.title }),
      icon: 'fa-bolt',
      hint: quickAddPreview(parsed) || 'enter',
      run: async () => {
        const out = await quickAdd(raw);
        if (out.ok && out.task) toast(out.scheduled ? `⚡ Scheduled “${out.task.title}”` : `✅ Added “${out.task.title}”`);
        else toast('⚠️ Couldn’t add that task');
      },
    };
    // Lead with quick-add when the line carries task signals (a date/time/tag/
    // priority) or nothing else matched; otherwise keep it as a fallback.
    const hasSignal = !!(parsed.deadline || parsed.startMin !== null || parsed.durationMin !== null || parsed.tags.length || parsed.priorityLabel);
    return hasSignal || matchedActions.length === 0 ? [quickItem, ...list] : [...list, quickItem];
  }, [query, actions, tasks]);

  useEffect(() => { setActive(0); }, [query]);

  if (!isOpen) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it) act(it.run); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return (
    <div className="cmdk-overlay" onClick={(e) => { if ((e.target as HTMLElement).className.includes('cmdk-overlay')) close(); }}>
      <div className="cmdk" role="dialog" aria-modal="true">
        <div className="cmdk-search">
          <i className="fa-solid fa-magnifying-glass"></i>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command or search tasks…"
          />
          <kbd className="cmd-kbd">esc</kbd>
        </div>
        <ul className="cmdk-list">
          {items.length === 0 && <li className="cmdk-empty">No matches</li>}
          {items.map((it, i) => (
            <li
              key={it.id}
              className={`cmdk-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => act(it.run)}
            >
              <i className={`fa-solid ${it.icon}`}></i>
              <span className="cmdk-label">{it.label}</span>
              {it.hint && <kbd className="cmd-kbd">{it.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
