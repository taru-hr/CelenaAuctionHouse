// Celena Auction House — Midnight BoE flipping view (one realm).
// Groups gear by item + item level and flags listings sitting far below the
// rest of their group (buy the cheap one, resell near the next price).

import { moneyHTML, moneyText, fmtQty, timeAgo } from './format.js';

const AH_CUT = 0.95;          // keep 95% after the auction house cut
const VISIBLE_LIMIT = 400;

const state = { rows: [], sortKey: 'profit', sortDir: -1, search: '', flipsOnly: false, minIlvl: 0, selected: null };
const $ = (id) => document.getElementById(id);

init();

async function init() {
  wireControls();
  try {
    const [latest, meta, status] = await Promise.all([
      getJSON('boe-latest.json'),
      getJSON('boe-meta.json').catch(() => ({})),
      getJSON('boe-status.json').catch(() => null),
    ]);
    state.rows = buildRows(latest, meta);
    renderStatus(status, latest);
    render();
  } catch (err) {
    console.error(err);
    showEmpty(
      `<h2>No BoE data yet</h2>
       <p>The hourly fetch hasn't produced BoE data for this realm yet. Run the
       <b>"Update auction data"</b> workflow, then check back after it finishes.</p>`
    );
  }
}

async function getJSON(p) {
  const r = await fetch('data/' + p, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}

function buildRows(latest, meta) {
  const out = [];
  for (const g of latest.items) {
    const m = meta[g.i];
    if (!m) continue; // unknown / not gear
    const p = g.p || [];
    if (!p.length) continue;
    const cheapest = p[0];
    const resell = p.length >= 2 ? p[1] : null; // undercut the next listing to resell
    const profit = resell ? Math.round(resell * AH_CUT - cheapest) : 0;
    const flipRoi = resell && profit > 0 ? profit / cheapest : 0;
    out.push({
      key: `${g.i}:${g.l}`, id: g.i, ilvl: g.l,
      name: m.n || `Item ${g.i}`, quality: m.q || 'COMMON', icon: m.i || '', slot: m.slot || '',
      count: g.n, listings: p, cheapest, resell, profit, flipRoi,
    });
  }
  return out;
}

// ------------------------------------------------------------- render ------
function render() {
  const q = state.search.trim().toLowerCase();
  let rows = state.rows.filter((r) => {
    if (state.minIlvl && r.ilvl < state.minIlvl) return false;
    if (state.flipsOnly && !(r.flipRoi >= 0.15 && r.profit > 0)) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const { sortKey, sortDir } = state;
  rows.sort((a, b) => {
    if (sortKey === 'name') { const av = a.name.toLowerCase(), bv = b.name.toLowerCase(); return av < bv ? -sortDir : av > bv ? sortDir : 0; }
    return ((a[sortKey] ?? -Infinity) - (b[sortKey] ?? -Infinity)) * sortDir;
  });

  const total = rows.length;
  $('rows').innerHTML = rows.slice(0, VISIBLE_LIMIT).map(rowHTML).join('');
  $('empty').hidden = total > 0;
  if (total === 0) showEmpty('<p>No gear matches your filters.</p>');
  $('count').textContent = total > VISIBLE_LIMIT
    ? `Showing ${VISIBLE_LIMIT} of ${total.toLocaleString()}`
    : `${total.toLocaleString()} listing group${total === 1 ? '' : 's'}`;

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.dataset.dir = th.dataset.sort === sortKey ? (sortDir === 1 ? 'asc' : 'desc') : '';
  });
  if (state.selected) highlightRow(state.selected);
}

function rowHTML(r) {
  const icon = r.icon
    ? `<img class="icon" loading="lazy" src="${r.icon}" alt="" onerror="this.style.visibility='hidden'">`
    : `<span class="icon icon-fallback q-${r.quality}">${esc(r.name[0] || '?')}</span>`;
  return `<tr data-key="${r.key}">
    <td class="c-item"><a class="item" href="#${r.key}">${icon}<span><span class="name q-${r.quality}">${esc(r.name)}</span>${r.slot ? `<span class="slot">${esc(r.slot)}</span>` : ''}</span></a></td>
    <td class="c-num ilvl">${r.ilvl || '?'}</td>
    <td class="c-num">${moneyHTML(r.cheapest)}</td>
    <td class="c-num dim">${r.resell ? moneyHTML(r.resell) : '—'}</td>
    <td class="c-num">${flipCell(r)}</td>
    <td class="c-num dim">${r.count}</td>
  </tr>`;
}

function flipCell(r) {
  if (!r.resell || r.profit <= 0) return '<span class="dim">—</span>';
  const cls = r.flipRoi >= 1 ? 'flip-hi' : r.flipRoi >= 0.25 ? 'flip-mid' : 'flip-lo';
  return `<span class="flip ${cls}" title="Buy ${moneyText(r.cheapest)} → resell ~${moneyText(r.resell)} (−5% cut). ROI ${Math.round(r.flipRoi * 100)}%">+${moneyHTML(r.profit)}</span>`;
}

// --------------------------------------------------------------- detail ----
function openDetail(key) {
  const r = state.rows.find((x) => x.key === key);
  if (!r) return;
  state.selected = key;
  highlightRow(key);
  const el = $('detail');
  el.hidden = false;
  el.classList.add('open');

  const spread = r.listings
    .map((v, i) => `<span class="lst ${i === 0 ? 'lst-cheap' : ''}">${moneyHTML(v)}</span>`)
    .join('<span class="lst-sep">·</span>');
  const flip = r.resell && r.profit > 0
    ? `<div class="d-flip">Snipe <b>${moneyText(r.cheapest)}</b> → resell ~<b>${moneyText(r.resell)}</b>
        <span class="dim">(−5% cut)</span> ≈ <b class="flip-hi">+${moneyText(r.profit)}</b>
        (ROI ${Math.round(r.flipRoi * 100)}%)</div>`
    : `<div class="d-flip d-flip-none">${r.resell ? 'Cheapest ≈ next listing — no margin.' : 'Only one listing — nothing to compare against.'}</div>`;

  el.innerHTML = `
    <div class="d-head">
      ${r.icon ? `<img class="d-icon" src="${r.icon}" alt="" onerror="this.style.visibility='hidden'">`
        : `<span class="d-icon icon-fallback q-${r.quality}">${esc(r.name[0] || '?')}</span>`}
      <div>
        <div class="d-name q-${r.quality}">${esc(r.name)}</div>
        <div class="d-sub">ilvl ${r.ilvl || '?'}${r.slot ? ` · ${esc(r.slot)}` : ''} · Item #${r.id} · ${r.count} listing${r.count === 1 ? '' : 's'}</div>
      </div>
      <button id="detailClose" class="d-close" aria-label="Close">×</button>
    </div>
    ${flip}
    <div class="d-label" style="margin:6px 2px">Cheapest listings (buyout)</div>
    <div class="d-listings">${spread}</div>`;
  $('detailClose').onclick = closeDetail;
}

function closeDetail() {
  state.selected = null;
  $('detail').classList.remove('open');
  $('detail').hidden = true;
  document.querySelectorAll('#rows tr.sel').forEach((tr) => tr.classList.remove('sel'));
}

// ------------------------------------------------------------- status ------
function renderStatus(status, latest) {
  const el = $('status');
  const realm = ((status && status.realm) || latest.realm || '').replace(/^\w/, (c) => c.toUpperCase());
  const updated = (status && status.updated) || latest.updated;
  let html = `<span class="dot"></span> ${realm} (EU) · ${(latest.count || 0).toLocaleString()} gear listings`;
  if (updated) html += ` · updated <b title="${new Date(updated * 1000).toLocaleString()}">${timeAgo(updated)}</b>`;
  el.innerHTML = html;
}

// ------------------------------------------------------------- controls ----
function wireControls() {
  $('search').addEventListener('input', debounce((e) => { state.search = e.target.value; render(); }, 120));
  $('flipsOnly').addEventListener('change', (e) => { state.flipsOnly = e.target.checked; render(); });
  $('minIlvl').addEventListener('input', debounce((e) => { state.minIlvl = Number(e.target.value) || 0; render(); }, 120));
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
      render();
    });
  });
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    e.preventDefault();
    openDetail(tr.dataset.key);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}

// --------------------------------------------------------------- utils -----
function highlightRow(key) {
  document.querySelectorAll('#rows tr.sel').forEach((tr) => tr.classList.remove('sel'));
  const tr = document.querySelector(`#rows tr[data-key="${CSS.escape(key)}"]`);
  if (tr) tr.classList.add('sel');
}
function showEmpty(html) { const el = $('empty'); el.hidden = false; el.innerHTML = html; $('rows').innerHTML = ''; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
