import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { exportCSV, exportJSON } from '../utils/export';
import { useStore } from '../store';
import { getStats } from '../db';

export function Analytics() {
  const { isAnalyticsOpen, setAnalyticsOpen } = useStore();
  const barRef = useRef<HTMLCanvasElement>(null);
  const pieRef = useRef<HTMLCanvasElement>(null);
  const doughRef = useRef<HTMLCanvasElement>(null);
  
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    if (isAnalyticsOpen) {
      getStats().then(setStats);
    }
  }, [isAnalyticsOpen]);

  useEffect(() => {
    if (!isAnalyticsOpen || !stats) return;

    // 1. Bar Chart (Tasks Completed)
    let barChart: Chart | null = null;
    if (barRef.current) {
      const ctx = barRef.current.getContext('2d');
      if (ctx) {
        barChart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: stats.weekData.map((d: any) => d.label).reverse(),
            datasets: [{
              label: 'Completed Tasks',
              data: stats.weekData.map((d: any) => d.count).reverse(),
              backgroundColor: '#7c5cfc',
              borderRadius: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false }
            }
          }
        });
      }
    }

    // 2. Pie Chart (Done vs Pending)
    let pieChart: Chart | null = null;
    if (pieRef.current) {
      const ctx = pieRef.current.getContext('2d');
      if (ctx) {
        pieChart = new Chart(ctx, {
          type: 'pie',
          data: {
            labels: ['Done', 'Pending'],
            datasets: [{
              data: [stats.done, stats.total - stats.done],
              backgroundColor: ['#3dffa3', '#4a4e6b'],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { color: '#7b7f9a' } }
            }
          }
        });
      }
    }

    // 3. Doughnut Chart (Priority Breakdown)
    let doughChart: Chart | null = null;
    if (doughRef.current) {
      const ctx = doughRef.current.getContext('2d');
      if (ctx) {
        doughChart = new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: ['High', 'Medium', 'Low'],
            datasets: [{
              data: [stats.high, stats.medium, stats.low],
              backgroundColor: ['#ff5c5c', '#f5d63d', '#3dffa3'],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { color: '#7b7f9a' } }
            }
          }
        });
      }
    }

    return () => {
      if (barChart) barChart.destroy();
      if (pieChart) pieChart.destroy();
      if (doughChart) doughChart.destroy();
    };
  }, [isAnalyticsOpen, stats]);

  if (!isAnalyticsOpen) return null;

  return (
    <div className="analytics-full">
      <div className="af-header">
        <div className="af-title">
          <i className="fa-solid fa-chart-pie"></i>
          <h2>Full Analytics Dashboard</h2>
        </div>
        <div className="af-actions">
          <button className="btn-ghost" title="Export as CSV" onClick={exportCSV}>
            <i className="fa-solid fa-file-csv"></i> CSV
          </button>
          <button className="btn-ghost" title="Export as JSON" onClick={exportJSON}>
            <i className="fa-solid fa-file-code"></i> JSON
          </button>
          <button className="btn-icon close-af" title="Close Analytics" onClick={() => setAnalyticsOpen(false)}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>

      <div className="af-content">
        <div className="af-stats-cards">
          <div className="af-card stat">
            <span className="sc-val">{stats?.total || 0}</span>
            <span className="sc-lbl">Total Tasks</span>
          </div>
          <div className="af-card stat">
            <span className="sc-val" style={{color: 'var(--success)'}}>{stats?.done || 0}</span>
            <span className="sc-lbl">Completed</span>
          </div>
          <div className="af-card stat">
            <span className="sc-val" style={{color: 'var(--accent)'}}>{stats?.pomos || 0}</span>
            <span className="sc-lbl">Pomodoros</span>
          </div>
          <div className="af-card stat">
            <span className="sc-val" style={{color: 'var(--violet)'}}>{stats?.focusHrs || 0}</span>
            <span className="sc-lbl">Focus Hours</span>
          </div>
        </div>

        <div className="af-charts-grid">
          <div className="af-card chart-large">
            <h3>Activity (Last 7 Days)</h3>
            <div className="canvas-container">
              <canvas ref={barRef}></canvas>
            </div>
          </div>
          <div className="af-card chart-small">
            <h3>Task Status</h3>
            <div className="canvas-container">
              <canvas ref={pieRef}></canvas>
            </div>
          </div>
          <div className="af-card chart-small">
            <h3>Priority Breakdown</h3>
            <div className="canvas-container">
              <canvas ref={doughRef}></canvas>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
