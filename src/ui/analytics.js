/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/analytics.js — Analytics Panel
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { state } from '../state.js';
import { getStats } from '../db.js';
import { exportJSON, exportCSV } from './export.js';
import Chart from 'chart.js/auto';

export function renderWeekChart(weekData) {
    const ctx = document.getElementById('weekChart');
    if (!ctx) return;

    const isDark = document.documentElement.dataset.theme !== 'light';
    const labels = weekData.map(d => d.label);
    const counts = weekData.map(d => d.count);

    if (state.weekChart) {
        state.weekChart.data.labels = labels;
        state.weekChart.data.datasets[0].data = counts;
        state.weekChart.update();
        return;
    }

    state.weekChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Completed',
                data: counts,
                backgroundColor: 'rgba(124,92,252,.65)',
                borderColor: '#7c5cfc',
                borderWidth: 1.5,
                borderRadius: 6,
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { color: isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)' },
                    ticks: { color: isDark ? '#7b7f9a' : '#5c5f78', font: { size: 10 } }
                },
                y: {
                    grid: { color: isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)' },
                    ticks: { color: isDark ? '#7b7f9a' : '#5c5f78', stepSize: 1, font: { size: 10 } }, beginAtZero: true
                }
            }
        }
    });
}

function $(id) { return document.getElementById(id); }

export async function refreshStats() {
    const s = await getStats();

    $('stat-done').textContent = s.done;
    $('stat-streak').textContent = s.streak;
    $('stat-focus').textContent = s.focusHrs;
    $('stat-urgent').textContent = s.urgent;
    $('badge-all').textContent = s.total;
    $('badge-today').textContent = s.todayCount;
    $('badge-high').textContent = s.highPending;

    // Analytics stats
    if ($('apTotal')) {
        $('apTotal').textContent = s.total;
        $('apDone').textContent = s.done;
        $('apPomos').textContent = s.pomos;
        $('apHours').textContent = s.focusHrs;

        // Priority bar
        const tot = s.high + s.medium + s.low || 1;
        $('pbHigh').style.width = `${(s.high / tot * 100).toFixed(1)}%`;
        $('pbMed').style.width = `${(s.medium / tot * 100).toFixed(1)}%`;
        $('pbLow').style.width = `${(s.low / tot * 100).toFixed(1)}%`;
    }

    renderWeekChart(s.weekData);
}

export function toggleAnalytics() {
    $('analyticsPanel').classList.toggle('hidden');
    const open = !$('analyticsPanel').classList.contains('hidden');
    $('nav-analytics').classList.toggle('active', open);
    if (open) refreshStats();
}

export function initAnalytics() {
    $('nav-analytics').addEventListener('click', toggleAnalytics);
    $('closeAnalytics').addEventListener('click', () => {
        $('analyticsPanel').classList.add('hidden');
        $('nav-analytics').classList.remove('active');
    });
    const mob = $('mobAnalytics'); if (mob) mob.addEventListener('click', toggleAnalytics);

    const btnJson = $('btnExportJSON'); if (btnJson) btnJson.addEventListener('click', exportJSON);
    const btnCsv = $('btnExportCSV'); if (btnCsv) btnCsv.addEventListener('click', exportCSV);
}
