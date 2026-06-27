import { useEffect, useRef, useState } from 'react';
import { exportCSV, exportJSON } from '../utils/export';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useStore } from '../store';
import { getStats } from '../db';
import { summarizeBoard, weeklyReport, assessDeadlineRisk, RiskItem } from '../services/aiService';
import { toast } from '../utils/toast';

// Palette — emerald accent, zinc neutrals, functional red/amber. No violet/neon.
const C_ACCENT = '#34d399';
const C_NEUTRAL = '#3f3f46';
const C_DANGER = '#f87171';
const C_WARNING = '#fbbf24';
const C_LABEL = '#a1a1aa';

export function Analytics() {
  const { isAnalyticsOpen, setAnalyticsOpen, currentTasks } = useStore();
  const barRef = useRef<HTMLCanvasElement>(null);
  const pieRef = useRef<HTMLCanvasElement>(null);
  const doughRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isAnalyticsOpen);

  const [stats, setStats] = useState<any>(null);
  const [summary, setSummary] = useState('');
  const [summaryBusy, setSummaryBusy] = useState<null | 'standup' | 'report'>(null);

  const [risks, setRisks] = useState<RiskItem[] | null>(null);
  const [riskBusy, setRiskBusy] = useState(false);

  const handleSummarize = async () => {
    setSummaryBusy('standup');
    try {
      setSummary(await summarizeBoard(currentTasks));
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setSummaryBusy(null);
    }
  };

  const handleReport = async () => {
    setSummaryBusy('report');
    try {
      setSummary(await weeklyReport(currentTasks, stats));
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setSummaryBusy(null);
    }
  };

  const handleAssessRisk = async () => {
    setRiskBusy(true);
    try {
      setRisks(await assessDeadlineRisk(currentTasks, stats));
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setRiskBusy(false);
    }
  };

  const taskTitle = (id: string) => currentTasks.find((t) => t.id === id)?.title || 'Task';

  useEffect(() => {
    if (isAnalyticsOpen) {
      getStats().then(setStats);
    }
  }, [isAnalyticsOpen]);

  useEffect(() => {
    if (!isAnalyticsOpen || !stats) return;

    // chart.js is ~150 KB — load it on demand the first time Insights opens,
    // so it stays out of the main bundle / cold-start path (Act 0 perf).
    const charts: Array<{ destroy(): void }> = [];
    let disposed = false;

    (async () => {
      const { default: Chart } = await import('chart.js/auto');
      if (disposed) return;

      const barCtx = barRef.current?.getContext('2d');
      if (barCtx) {
        charts.push(new Chart(barCtx, {
          type: 'bar',
          data: {
            labels: stats.weekData.map((d: any) => d.label).reverse(),
            datasets: [{
              label: 'Completed Tasks',
              data: stats.weekData.map((d: any) => d.count).reverse(),
              backgroundColor: C_ACCENT,
              borderRadius: 6,
              maxBarThickness: 26,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: C_LABEL } },
              y: { grid: { color: 'rgba(255,255,255,.06)' }, ticks: { color: C_LABEL, precision: 0 } as any },
            },
          }
        }));
      }

      const pieCtx = pieRef.current?.getContext('2d');
      if (pieCtx) {
        charts.push(new Chart(pieCtx, {
          type: 'doughnut',
          data: {
            labels: ['Done', 'Pending'],
            datasets: [{
              data: [stats.done, Math.max(stats.total - stats.done, 0)],
              backgroundColor: [C_ACCENT, C_NEUTRAL],
              borderWidth: 0,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: { legend: { position: 'bottom', labels: { color: C_LABEL, boxWidth: 10, usePointStyle: true } } }
          }
        }));
      }

      const doughCtx = doughRef.current?.getContext('2d');
      if (doughCtx) {
        charts.push(new Chart(doughCtx, {
          type: 'doughnut',
          data: {
            labels: ['High', 'Medium', 'Low'],
            datasets: [{
              data: [stats.high, stats.medium, stats.low],
              backgroundColor: [C_DANGER, C_WARNING, C_ACCENT],
              borderWidth: 0,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: { legend: { position: 'bottom', labels: { color: C_LABEL, boxWidth: 10, usePointStyle: true } } }
          }
        }));
      }
    })();

    return () => {
      disposed = true;
      charts.forEach((c) => c.destroy());
    };
  }, [isAnalyticsOpen, stats]);

  if (!isAnalyticsOpen) return null;

  return (
    <div ref={panelRef} className="insights" role="dialog" aria-modal="true" aria-label="Insights">
      <header className="insights-header">
        <div className="insights-title">
          <h2>Insights</h2>
          <p>A calm read on your momentum.</p>
        </div>
        <div className="insights-actions">
          <button className="btn-soft" title="Export as CSV" onClick={exportCSV}>
            <i className="fa-solid fa-file-csv"></i> CSV
          </button>
          <button className="btn-soft" title="Export as JSON" onClick={exportJSON}>
            <i className="fa-solid fa-file-code"></i> JSON
          </button>
          <button className="btn-icon" title="Close Insights" onClick={() => setAnalyticsOpen(false)}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      </header>

      <div className="bento">
        <section className="tile tile-activity">
          <h3>Activity</h3>
          <span className="tile-meta">Last 7 days</span>
          <div className="tile-canvas">
            <canvas ref={barRef}></canvas>
          </div>
        </section>

        <section className="tile tile-figure">
          <span className="figure-val">{stats?.focusHrs ?? 0}</span>
          <span className="figure-lbl">Focus hours</span>
        </section>

        <section className="tile tile-figure">
          <span className="figure-val" style={{ color: 'var(--accent)' }}>{stats?.done ?? 0}</span>
          <span className="figure-lbl">Completed</span>
        </section>

        <section className="tile tile-figure">
          <span className="figure-val">{stats?.streak ?? 0}<i className="fa-solid fa-fire figure-icon"></i></span>
          <span className="figure-lbl">Day streak</span>
        </section>

        <section className="tile tile-figure">
          <span className="figure-val">{stats?.pomos ?? 0}</span>
          <span className="figure-lbl">Pomodoros</span>
        </section>

        <section className="tile tile-chart">
          <h3>Status</h3>
          <div className="tile-canvas donut">
            <canvas ref={pieRef}></canvas>
          </div>
        </section>

        <section className="tile tile-chart">
          <h3>Priority</h3>
          <div className="tile-canvas donut">
            <canvas ref={doughRef}></canvas>
          </div>
        </section>

        <section className="tile tile-risk">
          <div className="tile-ai-head">
            <h3><i className="fa-solid fa-triangle-exclamation"></i> At risk</h3>
            <button className="btn-ai" disabled={riskBusy} onClick={handleAssessRisk}>
              <i className={`fa-solid ${riskBusy ? 'fa-spinner fa-spin' : 'fa-gauge-high'}`}></i>
              {risks ? 'Re-scan' : 'Scan'}
            </button>
          </div>
          {risks === null ? (
            <p className="tile-ai-text">AI checks your deadlines against recent velocity and flags what may slip.</p>
          ) : risks.length === 0 ? (
            <p className="tile-ai-text">Nothing flagged — your deadlines look achievable. ✨</p>
          ) : (
            <ul className="risk-list">
              {risks.map((r) => (
                <li key={r.id} className="risk-row">
                  <span className={`risk-dot ${r.risk}`}></span>
                  <div className="risk-info">
                    <span className="risk-title">{taskTitle(r.id)}</span>
                    <span className="risk-reason">{r.reason}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="tile tile-ai">
          <div className="tile-ai-head">
            <h3><i className="fa-solid fa-wand-magic-sparkles"></i> AI summary</h3>
            <div className="tile-ai-actions">
              <button className="btn-ai" disabled={!!summaryBusy} onClick={handleSummarize}>
                <i className={`fa-solid ${summaryBusy === 'standup' ? 'fa-spinner fa-spin' : 'fa-list-check'}`}></i>
                Standup
              </button>
              <button className="btn-ai" disabled={!!summaryBusy} onClick={handleReport}>
                <i className={`fa-solid ${summaryBusy === 'report' ? 'fa-spinner fa-spin' : 'fa-file-lines'}`}></i>
                Weekly report
              </button>
            </div>
          </div>
          <p className="tile-ai-text">
            {summary || 'Generate a quick standup, or a fuller weekly report from your tasks and stats.'}
          </p>
        </section>
      </div>
    </div>
  );
}
