import { useState } from 'react';
// import { useStore } from '../store';

export function Pomodoro() {
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [isActive, setIsActive] = useState(false);
  
  // Real logic will need to access Tauri IPC or WebWorkers later for background timing.

  const toggleTimer = () => setIsActive(!isActive);
  const resetTimer = () => {
    setIsActive(false);
    setTimeLeft(25 * 60);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const progressStyle = {
    strokeDashoffset: 106.81 - (106.81 * (timeLeft / (25 * 60)))
  };

  return (
    <div className="pomo-chip" id="pomoChip">
      <div className="pomo-ring-wrap">
        <svg viewBox="0 0 40 40" className="ring-svg">
          <circle className="r-bg" cx="20" cy="20" r="17"/>
          <circle 
            className="r-fg" 
            cx="20" cy="20" r="17" 
            strokeDasharray="106.81 106.81" 
            style={progressStyle}
          />
        </svg>
        <span className="pomo-time-txt">{formatTime(timeLeft)}</span>
      </div>
      <div className="pomo-meta">
        <p className="pomo-task-name">Select a task</p>
        <div className="pomo-controls">
          <button className="pomo-btn" onClick={toggleTimer} title="Play / Pause">
            <i className={`fa-solid ${isActive ? 'fa-pause' : 'fa-play'}`}></i>
          </button>
          <button className="pomo-btn" onClick={resetTimer} title="Reset">
            <i className="fa-solid fa-rotate-left"></i>
          </button>
        </div>
      </div>
    </div>
  );
}
