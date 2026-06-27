import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStore } from '../store';

const WORK = 25 * 60;

export function FocusMode() {
  const isOpen = useStore((s) => s.isFocusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const pomoTaskId = useStore((s: any) => s.pomoTaskId as string | undefined);
  const tasks = useStore((s) => s.currentTasks);
  const task = pomoTaskId ? tasks.find((t) => t.id === pomoTaskId) : undefined;

  const [timeLeft, setTimeLeft] = useState(WORK);
  const [total, setTotal] = useState(WORK);
  const [mode, setMode] = useState<'work' | 'break'>('work');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let offTick: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    (async () => {
      offTick = await listen<{ remaining: number; total: number; mode: 'work' | 'break' }>(
        'pomo-tick',
        (e) => { setTimeLeft(e.payload.remaining); setTotal(e.payload.total); setMode(e.payload.mode); setRunning(true); }
      );
      offDone = await listen('pomo-finished', () => setRunning(false));
    })();
    return () => { offTick?.(); offDone?.(); };
  }, [isOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen) setFocusMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, setFocusMode]);

  if (!isOpen) return null;

  const toggle = async () => { try { setRunning(await invoke<boolean>('toggle_pomodoro')); } catch { setRunning((r) => !r); } };
  const reset = async () => { try { await invoke('reset_pomodoro'); } catch { /* browser */ } setRunning(false); setTimeLeft(total); };
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const pct = 1 - timeLeft / Math.max(total, 1);

  return (
    <div className="focus-mode">
      <button className="focus-exit" onClick={() => setFocusMode(false)} title="Exit (Esc)">
        <i className="fa-solid fa-xmark"></i> Exit focus
      </button>

      <div className="focus-inner">
        <span className="focus-kicker">{mode === 'break' ? 'On a break' : 'Focusing on'}</span>
        <h1 className="focus-task">{mode === 'break' ? 'Take a breather ☕' : task?.title || 'No task selected'}</h1>

        <div className="focus-ring-wrap">
          <svg viewBox="0 0 220 220" className="focus-ring">
            <circle className="fr-bg" cx="110" cy="110" r="100" />
            <circle
              className="fr-fg" cx="110" cy="110" r="100"
              strokeDasharray={`${2 * Math.PI * 100}`}
              strokeDashoffset={2 * Math.PI * 100 * (1 - pct)}
            />
          </svg>
          <span className="focus-time">{fmt(timeLeft)}</span>
        </div>

        <div className="focus-controls">
          <button className="focus-btn primary" onClick={toggle}>
            <i className={`fa-solid ${running ? 'fa-pause' : 'fa-play'}`}></i>
            {running ? 'Pause' : 'Start'}
          </button>
          <button className="focus-btn" onClick={reset}>
            <i className="fa-solid fa-rotate-left"></i> Reset
          </button>
        </div>
      </div>
    </div>
  );
}
