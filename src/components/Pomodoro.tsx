import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStore } from '../store';
import { IS_TAURI } from '../db';

const WORK = 25 * 60;
const CIRC = 106.81; // 2πr, r = 17

interface TickPayload { remaining: number; total: number; mode: 'work' | 'break' }

export function Pomodoro() {
  const [timeLeft, setTimeLeft] = useState(WORK);
  const [total, setTotal] = useState(WORK);
  const [mode, setMode] = useState<'work' | 'break'>('work');
  const [isActive, setIsActive] = useState(false);

  const pomoTaskId = useStore((s: any) => s.pomoTaskId as string | undefined);
  const tasks = useStore((s) => s.currentTasks);
  const task = pomoTaskId ? tasks.find((t) => t.id === pomoTaskId) : undefined;

  useEffect(() => {
    let unlistenTick: () => void;
    let unlistenFinished: () => void;

    const setupListeners = async () => {
      if (!IS_TAURI) return; // No Rust timer in the browser fallback.
      unlistenTick = await listen<TickPayload>('pomo-tick', (event) => {
        setTimeLeft(event.payload.remaining);
        setTotal(event.payload.total);
        setMode(event.payload.mode);
        setIsActive(true);
      });
      unlistenFinished = await listen('pomo-finished', () => {
        setIsActive(false);
        window.dispatchEvent(new CustomEvent('pomo-finished-local'));
        // Auto-log the completed focus session against the active task.
        const id = useStore.getState() && (useStore.getState() as any).pomoTaskId;
        if (id) import('../services/taskService').then(({ addPomodoroToTask }) => addPomodoroToTask(id));
        import('../utils/notify').then(({ notify }) =>
          notify('Focus session complete', 'Time for a break — nice work. 🌿')
        );
      });
    };

    setupListeners();

    return () => {
      if (unlistenTick) unlistenTick();
      if (unlistenFinished) unlistenFinished();
    };
  }, []);

  const toggleTimer = async () => {
    if (!IS_TAURI) return; // Timer lives in Rust; no-op in the browser fallback.
    const active = await invoke<boolean>('toggle_pomodoro');
    setIsActive(active);
  };

  const resetTimer = async () => {
    if (!IS_TAURI) return;
    await invoke('reset_pomodoro');
    setIsActive(false);
    setTimeLeft(total);
    setMode('work');
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const sessions = task?.pomodoros_spent ?? 0;

  return (
    <div className={`pomo-dock ${isActive ? 'is-running' : ''}`} id="pomoChip">
      <div className="pomo-ring-wrap">
        <svg viewBox="0 0 40 40" className="ring-svg">
          <circle className="r-bg" cx="20" cy="20" r="17" />
          <circle
            className="r-fg"
            cx="20"
            cy="20"
            r="17"
            strokeDasharray={`${CIRC} ${CIRC}`}
            style={{ strokeDashoffset: CIRC - CIRC * (timeLeft / Math.max(total, 1)) }}
          />
        </svg>
        <span className="pomo-time-txt">{formatTime(timeLeft)}</span>
      </div>

      <div className="pomo-meta">
        <p className="pomo-task-name" title={task?.title || 'Select a task to focus'}>
          {mode === 'break' ? '☕ Break' : task?.title || 'Select a task'}
        </p>
        <div className="pomo-row">
          <div className="pomo-controls">
            <button className="pomo-btn primary" onClick={toggleTimer} title="Play / Pause">
              <i className={`fa-solid ${isActive ? 'fa-pause' : 'fa-play'}`}></i>
            </button>
            <button className="pomo-btn" onClick={resetTimer} title="Reset">
              <i className="fa-solid fa-rotate-left"></i>
            </button>
          </div>
          <span className="pomo-sessions">{sessions} {sessions === 1 ? 'session' : 'sessions'}</span>
        </div>
      </div>
    </div>
  );
}
