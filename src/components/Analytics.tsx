import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';

export function Analytics() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    
    // Stub chart logic based on vanilla implementation
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
        datasets: [{
          label: 'Completed Tasks',
          data: [1, 5, 2, 8, 3, 0, 4],
          backgroundColor: '#ffe24a',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false }
        }
      }
    });

    return () => chart.destroy();
  }, []);

  return (
    <aside className="analytics-panel">
      <div className="ap-hd">
        <h3><i className="fa-solid fa-chart-column"></i> Analytics</h3>
        <div>
          <button className="icon-btn" title="Export CSV" style={{fontSize: '0.9rem', marginRight: '4px'}}>⬇ CSV</button>
          <button className="icon-btn" title="Export JSON" style={{fontSize: '0.9rem', marginRight: '8px'}}>⬇ JSON</button>
          <button className="icon-btn"><i className="fa-solid fa-xmark"></i></button>
        </div>
      </div>

      <div className="chart-section">
        <p className="chart-label">Tasks completed — last 7 days</p>
        <canvas ref={canvasRef}></canvas>
      </div>

      <div className="ap-stats-grid">
        <div className="ap-stat"><span className="ap-val">0</span><span className="ap-lbl">Total</span></div>
        <div className="ap-stat"><span className="ap-val">0</span><span className="ap-lbl">Done</span></div>
        <div className="ap-stat"><span className="ap-val">0</span><span className="ap-lbl">Pomodoros</span></div>
        <div className="ap-stat"><span className="ap-val">0</span><span className="ap-lbl">Focus hrs</span></div>
      </div>

      <div className="priority-breakdown">
        <h4>Priority Breakdown</h4>
        <div className="pb-track">
          <div className="pb-seg high" style={{width: '33%'}}></div>
          <div className="pb-seg medium" style={{width: '33%'}}></div>
          <div className="pb-seg low" style={{width: '34%'}}></div>
        </div>
        <div className="pb-legend">
          <span><span className="dot high"></span> High</span>
          <span><span className="dot medium"></span> Medium</span>
          <span><span className="dot low"></span> Low</span>
        </div>
      </div>
    </aside>
  );
}
