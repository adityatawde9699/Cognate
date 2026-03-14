/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/tags.js — Tags sidebar navigation (M5)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { setFilter } from './nav.js';
import { state } from '../state.js';
import { esc } from '../utils/format.js';

export function renderTagsNav() {
    const container = document.getElementById('tagsNav');
    if (!container) return;

    // Collect unique tags from all loaded tasks
    const tagCounts = {};
    for (const t of state.currentTasks) {
        if (!t.done) {
            for (const tag of (t.tags || [])) {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            }
        }
    }

    const tags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]);
    if (tags.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = '<div class="tags-hd">Tags</div>';
    tags.forEach(t => {
        const active = state.currentFilter === `tag:${t}` ? ' active' : '';
        html += `<button class="tag-nav-btn${active}" data-tag="${esc(t)}">
            <span class="tn-hash">#</span> ${esc(t)}
            <span class="tn-count">${tagCounts[t]}</span>
        </button>`;
    });

    container.innerHTML = html;
    container.querySelectorAll('.tag-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => setFilter(`tag:${btn.dataset.tag}`));
    });
}
