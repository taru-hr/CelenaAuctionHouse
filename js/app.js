// Celena Auction House — main app.
// Loads the hourly commodities snapshot, renders a sortable/filterable table,
// and shows a price-history chart + "buy signal" when you pick an item.

import { loadIndex, loadHistory } from './data.js';
import { moneyHTML, moneyText, fmtQty, timeAgo } from './format.js';
import { PriceChart } from './chart.js';

const VISIBLE_LIMIT = 400; // cap rendered rows for performance; search to narrow
const QUALITIES = ['POOR', 'COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ARTIFACT', 'HEIRLOOM'];

// Items from the current expansion (Midnight, 12.0) cluster above this id; legacy
// goods sprawl below it. Bump toward 237000 for a stricter Midnight-only view.
const CURRENT_EXPANSION_MIN_ID = 234000;

// Retail auction house takes a 5% cut on a sale, so you keep 95% of the sale price.
const AH_CUT = 0.95;

const state = {
  rows: [],
  sortKey: 'flip',
  sortDir: -1, // -1 desc, 1 asc
  search: '',
  quality: 'ALL',
  tier: 'ALL',
  currentExpOnly: true,
  dealsOnly: false,
  selected: null,
};

let chart = null;
const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------- boot ------
init();

async function init() {
  wireControls();
  try {
    const { status, latest, meta } = await loadIndex();
    state.rows = buildRows(latest, meta);
    renderStatus(status, latest);
    render();
  } catch (err) {
    console.error(err);
    showEmpty(
      `<h2>No auction data yet</h2>
       <p>The site is live, but the hourly fetch hasn't produced data yet.</p>
       <p>Add your Blizzard API keys as repo secrets, then run the
       <b>“Update auction data”</b> workflow (Actions tab → Run workflow).
       See the <a href="https://github.com" target="_blank" rel="noopener">README</a> for the exact steps.</p>`
    );
  }
}

// --------------------------------------------------------------- data ------
function buildRows(latest, meta) {
  const out = [];
  for (const [id, min, market, qty, pct24, avg14, low14, spd] of latest.items) {
    const m = meta[id] || {};
    const avg = avg14 || market;
    const below = avg > 0 ? (avg - market) / avg : 0; // 0.12 => 12% under typical
    const nearLow = market <= (low14 || min) * 1.02;
    // Flip: buy the cheapest listing, resell at market, minus the 5% AH cut.
    const flipProfit = Math.round(market * AH_CUT - min);
    const flipRoi = min > 0 && flipProfit > 0 ? flipProfit / min : 0;
    // Sell-through: how fast the standing supply clears at the estimated pace.
    const sold = spd == null ? null : spd;
    const { vel, dos } = classifyVelocity(sold, qty);
    out.push({
      id,
      name: m.n || `Item ${id}`,
      quality: m.q || 'COMMON',
      icon: m.i || '',
      min, market, qty,
      pct24: pct24 == null ? null : pct24,
      avg14: avg, low14: low14 || min,
      below, nearLow, flipProfit, flipRoi,
      spd: sold, vel, dos,
      tier: 0, tierCount: 0,
    });
  }
  computeTiers(out);
  return out;
}

// Turn an estimated units-sold-per-day into a demand class + days-of-supply.
// Days-of-supply (standing qty ÷ daily sales) is item-type-agnostic: it answers
// "if I buy and relist, how long until the shelf ahead of me clears?" — the real
// flip question. Raw volume can't compare a bulk herb to a niche flask; this can.
function classifyVelocity(spd, qty) {
  if (spd == null) return { vel: null, dos: null };
  if (spd < 1) return { vel: 'illiquid', dos: qty > 0 ? qty / Math.max(spd, 0.05) : null };
  const dos = qty / spd;
  const vel = dos < 1 ? 'fast' : dos < 4 ? 'steady' : 'slow';
  return { vel, dos };
}

// Crafting-quality tiers (Dragonflight+) are separate item IDs sharing a name,
// numbered consecutively (T1 = base id, T2 = base+1, …). So group by name and
// derive the tier from the id offset. A tight-cluster guard avoids treating
// unrelated same-named items as tiers.
function computeTiers(rows) {
  const byName = new Map();
  for (const r of rows) {
    let g = byName.get(r.name);
    if (!g) byName.set(r.name, (g = []));
    g.push(r);
  }
  for (const g of byName.values()) {
    if (g.length < 2 || g.length > 5) continue;
    let min = Infinity, max = -Infinity;
    for (const r of g) { if (r.id < min) min = r.id; if (r.id > max) max = r.id; }
    if (max - min > 4) continue; // scattered ids => not a crafting-quality set
    const count = max - min + 1;
    for (const r of g) { r.tier = r.id - min + 1; r.tierCount = count; }
  }
}

// ------------------------------------------------------------- render ------
function render() {
  const q = state.search.trim().toLowerCase();
  let rows = state.rows.filter((r) => {
    if (state.currentExpOnly && r.id < CURRENT_EXPANSION_MIN_ID) return false;
    if (state.quality !== 'ALL' && r.quality !== state.quality) return false;
    if (state.tier !== 'ALL' && String(r.tier) !== state.tier) return false;
    if (state.dealsOnly && !(r.nearLow || r.below >= 0.08)) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const { sortKey, sortDir } = state;
  rows.sort((a, b) => {
    let av, bv;
    if (sortKey === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return av < bv ? -sortDir : av > bv ? sortDir : 0; }
    if (sortKey === 'deal') { av = a.below; bv = b.below; }
    else if (sortKey === 'flip') { av = a.flipRoi; bv = b.flipRoi; }
    else { av = a[sortKey]; bv = b[sortKey]; }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    return (av - bv) * sortDir;
  });

  const total = rows.length;
  const shown = rows.slice(0, VISIBLE_LIMIT);
  $('rows').innerHTML = shown.map(rowHTML).join('');
  $('empty').hidden = total > 0;
  if (total === 0) showEmpty('<p>No items match your filters.</p>');
  $('count').textContent = total > VISIBLE_LIMIT
    ? `Showing ${VISIBLE_LIMIT} of ${total.toLocaleString()} — search to narrow`
    : `${total.toLocaleString()} item${total === 1 ? '' : 's'}`;

  updateSortIndicators();
  if (state.selected != null) highlightRow(state.selected);
}

function rowHTML(r) {
  const iconCell = r.icon
    ? `<img class="icon" loading="lazy" src="${r.icon}" alt="" onerror="this.style.visibility='hidden'">`
    : `<span class="icon icon-fallback q-${r.quality}">${esc(r.name[0] || '?')}</span>`;

  return `<tr data-id="${r.id}">
    <td class="c-item"><a class="item" href="#item-${r.id}">${iconCell}<span class="name q-${r.quality}">${esc(r.name)}</span>${tierBadge(r)}</a></td>
    <td class="c-num">${moneyHTML(r.min)}</td>
    <td class="c-num">${moneyHTML(r.market)}</td>
    <td class="c-num">${flipCell(r)}</td>
    <td class="c-num dim">${fmtQty(r.qty)}</td>
    <td class="c-num">${demandCell(r)}</td>
    <td class="c-deal">${dealBadge(r)}</td>
  </tr>`;
}

// "Sells ~X/day" coloured by demand speed; the tooltip explains days-of-supply.
function demandCell(r) {
  if (r.spd == null) return '<span class="dim" title="Not enough history yet — fills in after a few hourly updates">—</span>';
  const dosTxt = r.dos != null && isFinite(r.dos) ? ` · ≈ ${fmtDos(r.dos)} of supply` : '';
  return `<span class="vel vel-${r.vel}" title="${velLabel(r.vel)}${dosTxt}">${fmtQty(r.spd)}<span class="per">/day</span></span>`;
}

function velLabel(vel) {
  return vel === 'fast' ? 'Sells fast — clears in under a day'
    : vel === 'steady' ? 'Steady demand'
    : vel === 'slow' ? 'Slow — supply outpaces sales'
    : vel === 'illiquid' ? 'Illiquid — barely trades'
    : 'Demand unknown';
}

// Days-of-supply as a short human string ("18h", "2.3 days", "30+ days").
function fmtDos(dos) {
  if (dos < 1) return Math.round(dos * 24) + 'h';
  if (dos > 30) return '30+ days';
  return (dos < 10 ? dos.toFixed(1) : Math.round(dos)) + ' days';
}

// Profit if you buy the cheapest listing and resell at market (after the AH cut).
function flipCell(r) {
  if (r.flipRoi < 0.02) return '<span class="dim">—</span>';
  const cls = r.flipRoi >= 0.25 ? 'flip-hi' : r.flipRoi >= 0.1 ? 'flip-mid' : 'flip-lo';
  return `<span class="flip ${cls}" title="Buy ${moneyText(r.min)} → resell ~${moneyText(r.market)} (−5% cut) ≈ +${moneyText(r.flipProfit)} each">+${Math.round(r.flipRoi * 100)}%</span>`;
}

function flipSummary(r) {
  if (r.flipRoi < 0.02) {
    return `<div class="d-flip d-flip-none">Thin margin — buy ≈ sell after the 5% cut. Not a flip right now.</div>`;
  }
  // A fat margin on something that barely sells can leave your gold tied up.
  const caveat = (r.vel === 'slow' || r.vel === 'illiquid')
    ? ` <span class="dim">— but it sells ${r.vel === 'illiquid' ? 'rarely' : 'slowly'}, so your gold may sit a while.</span>`
    : '';
  return `<div class="d-flip">Flip: buy <b>${moneyText(r.min)}</b> → resell ~<b>${moneyText(r.market)}</b>
    <span class="dim">(−5% cut)</span> ≈ <b class="flip-hi">+${moneyText(r.flipProfit)}</b> each (<b>+${Math.round(r.flipRoi * 100)}%</b>)${caveat}</div>`;
}

// Demand line in the detail panel: units/day + days-of-supply + plain-English read.
function velSummary(r) {
  if (r.spd == null) {
    return `<div class="d-vel d-vel-none">Demand: still building — an estimate appears after a few hourly updates.</div>`;
  }
  const dosTxt = r.dos != null && isFinite(r.dos)
    ? ` · ~<b>${fmtDos(r.dos)}</b> of supply at that pace` : '';
  return `<div class="d-vel d-vel-${r.vel}">Sells ~<b>${fmtQty(r.spd)}/day</b> region-wide${dosTxt}.
    <span class="dim">${velLabel(r.vel)}.</span></div>`;
}

function tierBadge(r) {
  if (!r.tier) return '';
  return `<span class="tier t${r.tier}" title="Crafting quality ${r.tier} of ${r.tierCount}">${r.tier}</span>`;
}

function dealBadge(r) {
  const pct = Math.round(r.below * 100);
  if (r.nearLow) return `<span class="badge b-best" title="Near its 14-day low">near low</span>`;
  if (r.below >= 0.15) return `<span class="badge b-good">−${pct}%</span>`;
  if (r.below >= 0.05) return `<span class="badge b-ok">−${pct}%</span>`;
  if (r.below <= -0.1) return `<span class="badge b-high">+${-pct}%</span>`;
  return `<span class="badge b-flat">≈ avg</span>`;
}

// --------------------------------------------------------------- detail ----
async function openDetail(id) {
  const r = state.rows.find((x) => x.id === id);
  if (!r) return;
  state.selected = id;
  highlightRow(id);

  const el = $('detail');
  el.hidden = false;
  el.classList.add('open');
  el.innerHTML = detailShell(r);
  $('detailClose').onclick = closeDetail;

  const canvas = $('chartCanvas');
  chart = new PriceChart(canvas);
  chart.setData(null);

  const h = await loadHistory(id);
  renderDetailStats(r, h);
  chart.setData(h);
}

function detailShell(r) {
  const iconHTML = r.icon
    ? `<img class="d-icon" src="${r.icon}" alt="" onerror="this.style.visibility='hidden'">`
    : `<span class="d-icon icon-fallback q-${r.quality}">${esc(r.name[0] || '?')}</span>`;
  return `
    <div class="d-head">
      ${iconHTML}
      <div>
        <div class="d-name q-${r.quality}">${esc(r.name)}${tierBadge(r)}</div>
        <div class="d-sub">Item #${r.id} · region-wide commodity${r.tier ? ` · crafting quality ${r.tier}/${r.tierCount}` : ''}</div>
      </div>
      <button id="detailClose" class="d-close" aria-label="Close">×</button>
    </div>
    <div class="d-price">
      <div><span class="d-label">Cheapest</span>${moneyHTML(r.min)}</div>
      <div><span class="d-label">Market</span>${moneyHTML(r.market)}</div>
      <div><span class="d-label">Quantity</span><span class="d-qty">${fmtQty(r.qty)}</span></div>
    </div>
    ${flipSummary(r)}
    ${velSummary(r)}
    <div id="signal" class="d-signal"></div>
    <div class="d-chart"><canvas id="chartCanvas"></canvas></div>
    <div class="d-legend"><span class="k-market">Market price</span><span class="k-min">Cheapest</span></div>
    <div id="dstats" class="d-stats"></div>`;
}

function renderDetailStats(r, h) {
  const signal = $('signal');
  const dstats = $('dstats');
  if (!h || !h.p || !h.p.length) {
    signal.innerHTML = `<span class="sig sig-flat">History is still building — check back after a few hourly updates.</span>`;
    dstats.innerHTML = '';
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const win = now - 14 * 86400;
  let lo = Infinity, hi = -Infinity, sum = 0, k = 0;
  for (let i = 0; i < h.t.length; i++) {
    if (h.t[i] < win) continue;
    const v = h.p[i];
    lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; k++;
  }
  if (!k) { lo = Math.min(...h.p); hi = Math.max(...h.p); sum = h.p.reduce((a, b) => a + b, 0); k = h.p.length; }
  const avg = Math.round(sum / k);
  const pos = hi > lo ? (r.market - lo) / (hi - lo) : 0; // 0 = at the low, 1 = at the high

  let cls = 'sig-flat', msg = 'Around its typical price.';
  if (r.market <= lo * 1.02) { cls = 'sig-best'; msg = "Cheapest it's been in ~14 days — good time to buy."; }
  else if (r.below >= 0.1) { cls = 'sig-good'; msg = `About ${Math.round(r.below * 100)}% below its typical price.`; }
  else if (r.below <= -0.1) { cls = 'sig-high'; msg = 'Pricier than usual — you may want to wait.'; }
  signal.innerHTML = `<span class="sig ${cls}">${msg}</span>`;

  dstats.innerHTML = `
    <div class="stat"><span>14-day low</span>${moneyHTML(lo)}</div>
    <div class="stat"><span>14-day avg</span>${moneyHTML(avg)}</div>
    <div class="stat"><span>14-day high</span>${moneyHTML(hi)}</div>
    <div class="stat wide"><span>Where it sits now</span>
      <div class="range"><div class="range-fill" style="width:${Math.round(pos * 100)}%"></div>
      <div class="range-dot" style="left:${Math.round(pos * 100)}%" title="${moneyText(r.market)}"></div></div>
      <div class="range-ends"><em>low</em><em>high</em></div>
    </div>`;
}

function closeDetail() {
  state.selected = null;
  const el = $('detail');
  el.classList.remove('open');
  el.hidden = true;
  document.querySelectorAll('#rows tr.sel').forEach((tr) => tr.classList.remove('sel'));
}

// ------------------------------------------------------------- status ------
function renderStatus(status, latest) {
  const el = $('status');
  const updated = (status && status.updated) || (latest && latest.updated);
  const count = (status && status.items) || (latest && latest.count) || 0;
  const region = ((status && status.region) || latest.region || 'eu').toUpperCase();
  let html = `<span class="dot"></span> ${region} commodities · ${count.toLocaleString()} items`;
  if (updated) html += ` · updated <b title="${new Date(updated * 1000).toLocaleString()}">${timeAgo(updated)}</b>`;
  if (status && status.metaMissing > 0) html += ` · <span class="dim">${status.metaMissing} names filling in…</span>`;
  el.innerHTML = html;
}

// ------------------------------------------------------------- controls ----
function wireControls() {
  buildQualityOptions();

  $('search').addEventListener('input', debounce((e) => { state.search = e.target.value; render(); }, 120));
  $('quality').addEventListener('change', (e) => { state.quality = e.target.value; render(); });
  $('tier').addEventListener('change', (e) => { state.tier = e.target.value; render(); });
  $('currentExp').addEventListener('change', (e) => { state.currentExpOnly = e.target.checked; render(); });
  $('dealsOnly').addEventListener('change', (e) => { state.dealsOnly = e.target.checked; render(); });

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
      render();
    });
  });

  // Row click -> open detail (event delegation).
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    e.preventDefault();
    openDetail(Number(tr.dataset.id));
  });

  window.addEventListener('resize', debounce(() => { if (chart) chart.render(); }, 100));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}

function buildQualityOptions() {
  const sel = $('quality');
  sel.innerHTML = '<option value="ALL">All rarities</option>' +
    QUALITIES.map((q) => `<option value="${q}">${q[0] + q.slice(1).toLowerCase()}</option>`).join('');
}

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    th.dataset.dir = th.dataset.sort === state.sortKey ? (state.sortDir === 1 ? 'asc' : 'desc') : '';
  });
}

// --------------------------------------------------------------- utils -----
function highlightRow(id) {
  document.querySelectorAll('#rows tr.sel').forEach((tr) => tr.classList.remove('sel'));
  const tr = document.querySelector(`#rows tr[data-id="${id}"]`);
  if (tr) tr.classList.add('sel');
}

function showEmpty(html) {
  const el = $('empty');
  el.hidden = false;
  el.innerHTML = html;
  $('rows').innerHTML = '';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
