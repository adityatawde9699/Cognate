import { useStore } from '../store';
import { restoreFromTrash, purgeTask, emptyTrash } from '../services/taskService';
import { toast } from '../utils/toast';

/**
 * Trash — the recovery surface for soft-deleted tasks.
 * `useTasks` hydrates `currentTasks` with the trashed rows when the active
 * filter is `trash`, so this view reads straight from the store.
 */
export function TrashView() {
  const tasks = useStore((s) => s.currentTasks);

  const handleRestore = async (id: string, title: string) => {
    await restoreFromTrash(id);
    toast(`Restored "${title}"`);
  };

  const handlePurge = async (id: string, title: string) => {
    if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    await purgeTask(id);
    toast('Deleted forever');
  };

  const handleEmpty = async () => {
    if (tasks.length === 0) return;
    if (!window.confirm(`Permanently delete all ${tasks.length} task(s) in Trash? This cannot be undone.`)) return;
    const n = await emptyTrash();
    toast(`Emptied Trash (${n})`);
  };

  return (
    <section className="trash-view" aria-label="Trash">
      <header className="canvas-header">
        <div className="canvas-heading">
          <div className="canvas-eyebrow">
            <i className="fa-solid fa-trash-can"></i> Recoverable
          </div>
          <h1 className="canvas-title">Trash</h1>
          <p className="canvas-sub">
            Deleted tasks live here until you restore or permanently remove them.
          </p>
        </div>
        <div className="canvas-actions">
          <button
            className="btn-ghost"
            onClick={handleEmpty}
            disabled={tasks.length === 0}
            title="Permanently delete everything in Trash"
          >
            <i className="fa-solid fa-broom"></i>
            <span>Empty Trash</span>
          </button>
        </div>
      </header>

      {tasks.length === 0 ? (
        <div className="trash-empty">
          <i className="fa-solid fa-feather"></i>
          <p>Trash is empty.</p>
        </div>
      ) : (
        <ul className="trash-list">
          {tasks.map((t) => (
            <li key={t.id} className="trash-row">
              <div className="trash-row-main">
                <span className="trash-row-title">{t.title}</span>
                {t.deleted_at && (
                  <span className="trash-row-meta">
                    Deleted {new Date(t.deleted_at).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="trash-row-actions">
                <button
                  className="btn-ghost"
                  onClick={() => handleRestore(t.id, t.title)}
                  title="Restore this task"
                >
                  <i className="fa-solid fa-rotate-left"></i>
                  <span>Restore</span>
                </button>
                <button
                  className="btn-ghost is-danger"
                  onClick={() => handlePurge(t.id, t.title)}
                  title="Delete permanently"
                >
                  <i className="fa-solid fa-xmark"></i>
                  <span>Delete</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
