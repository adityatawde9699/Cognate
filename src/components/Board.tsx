import { useStore, Task } from '../store';
import { TaskCard } from './TaskCard';

export function Board() {
  const visibleTasks = useStore((state: any) => state.getVisibleTasks());
  
  const pending = visibleTasks.filter((t: Task) => !t.done);
  const done = visibleTasks.filter((t: Task) => t.done);

  const handleEdit = (task: Task) => {
    console.log("Edit task", task.id);
  };

  const handleSelectPomo = (task: Task) => {
    console.log("Select pomo", task.id);
  };

  const handleDrop = async (e: React.DragEvent, targetId?: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('taskId');
    if (!draggedId || draggedId === targetId) return;
    
    // Reorder logic
  };

  const allowDrop = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div className="board" onDragOver={allowDrop} onDrop={e => handleDrop(e)}>
      <section className="col">
        <div className="col-hd">
          <i className="fa-solid fa-hourglass-half"></i>
          Pending
          <span className="col-count">{pending.length}</span>
        </div>
        <div className="task-list" id="pendingList">
          {pending.length === 0 ? (
            <div className="empty-state">
              <div className="empty-emoji">🌱</div>
              <p>No pending tasks. You're on fire! 🔥</p>
            </div>
          ) : (
            pending.map((task: Task) => (
              <div key={task.id} onDrop={e => handleDrop(e, task.id)}>
                <TaskCard 
                  task={task} 
                  onEdit={handleEdit} 
                  onSelectPomo={handleSelectPomo} 
                />
              </div>
            ))
          )}
        </div>
      </section>

      <section className="col">
        <div className="col-hd done-hd">
          <i className="fa-solid fa-circle-check"></i>
          Completed
          <span className="col-count">{done.length}</span>
        </div>
        <div className="task-list" id="doneList">
          {done.length === 0 ? (
            <div className="empty-state">
              <div className="empty-emoji">📋</div>
              <p>Complete a task to see it here.</p>
            </div>
          ) : (
            done.map((task: Task) => (
              <TaskCard 
                key={task.id}
                task={task} 
                onEdit={handleEdit} 
                onSelectPomo={handleSelectPomo} 
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
