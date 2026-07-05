// A tiny dependency-free canvas price chart with hover tooltip.
// series = { t:[unixSec], p:[marketCopper], m:[minCopper], q:[qty] }

import { moneyText, fmtQty, fmtDateShort, fmtDateTime, moneyParts } from './format.js';

const PAD = { top: 16, right: 14, bottom: 26, left: 62 };

export class PriceChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = null;
    this.hover = -1;
    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseleave', () => { this.hover = -1; this.render(); });
  }

  setData(series) {
    this.series = series && series.t && series.t.length ? series : null;
    this.hover = -1;
    this.render();
  }

  _plot() {
    const r = this.canvas.getBoundingClientRect();
    return {
      w: r.width, h: r.height,
      x0: PAD.left, x1: r.width - PAD.right,
      y0: PAD.top, y1: r.height - PAD.bottom,
    };
  }

  _onMove(e) {
    if (!this.series) return;
    const r = this.canvas.getBoundingClientRect();
    const p = this._plot();
    const x = e.clientX - r.left;
    const n = this.series.t.length;
    const rel = (x - p.x0) / Math.max(1, p.x1 - p.x0);
    const i = Math.round(rel * (n - 1));
    const clamped = Math.max(0, Math.min(n - 1, i));
    if (clamped !== this.hover) { this.hover = clamped; this.render(); }
  }

  render() {
    const cv = this.canvas;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    if (rect.width === 0) return;
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const css = getComputedStyle(document.documentElement);
    const cGrid = css.getPropertyValue('--grid').trim() || '#2a2f3a';
    const cText = css.getPropertyValue('--muted').trim() || '#8b93a7';
    const cLine = css.getPropertyValue('--accent').trim() || '#f0b429';
    const cMin = css.getPropertyValue('--accent-2').trim() || '#5fa8ff';

    const s = this.series;
    if (!s) {
      ctx.fillStyle = cText;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No history yet — points appear each hour.', rect.width / 2, rect.height / 2);
      return;
    }

    const p = this._plot();
    const n = s.t.length;
    const tMin = s.t[0], tMax = s.t[n - 1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, s.p[i], s.m[i]); hi = Math.max(hi, s.p[i]); }
    if (lo === hi) { lo *= 0.95; hi *= 1.05; }
    const padY = (hi - lo) * 0.1;
    lo = Math.max(0, lo - padY); hi = hi + padY;

    const X = (t) => p.x0 + ((t - tMin) / Math.max(1, tMax - tMin)) * (p.x1 - p.x0);
    const Y = (v) => p.y1 - ((v - lo) / Math.max(1, hi - lo)) * (p.y1 - p.y0);

    // --- horizontal grid + y labels (gold value) ---
    ctx.strokeStyle = cGrid;
    ctx.fillStyle = cText;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = lo + ((hi - lo) * i) / ticks;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y); ctx.stroke();
      const g = moneyParts(v).g;
      ctx.fillText(g >= 1000 ? (g / 1000).toFixed(1) + 'kg' : g + 'g', p.x0 - 8, y);
    }

    // --- x labels (dates) ---
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = Math.min(6, n - 1) || 1;
    for (let i = 0; i <= xTicks; i++) {
      const t = tMin + ((tMax - tMin) * i) / xTicks;
      ctx.fillText(fmtDateShort(t), X(t), p.y1 + 6);
    }

    // --- min-price line (faint) ---
    ctx.strokeStyle = cMin;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = X(s.t[i]), y = Y(s.m[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // --- market-price area + line ---
    const grad = ctx.createLinearGradient(0, p.y0, 0, p.y1);
    grad.addColorStop(0, hexA(cLine, 0.28));
    grad.addColorStop(1, hexA(cLine, 0));
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = X(s.t[i]), y = Y(s.p[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.lineTo(X(tMax), p.y1); ctx.lineTo(X(tMin), p.y1); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = X(s.t[i]), y = Y(s.p[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = cLine; ctx.lineWidth = 1.8; ctx.stroke();

    // --- hover crosshair + marker + tooltip ---
    if (this.hover >= 0 && this.hover < n) {
      const i = this.hover;
      const x = X(s.t[i]), y = Y(s.p[i]);
      ctx.strokeStyle = hexA(cText, 0.4);
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, p.y0); ctx.lineTo(x, p.y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cLine;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      this._tooltip(ctx, p, x, y, i);
    }
  }

  _tooltip(ctx, p, x, y, i) {
    const s = this.series;
    const lines = [
      fmtDateTime(s.t[i]),
      'Market: ' + moneyText(s.p[i]),
      'Cheapest: ' + moneyText(s.m[i]),
      'Qty: ' + fmtQty(s.q[i]),
    ];
    ctx.font = '11px system-ui, sans-serif';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const h = lines.length * 15 + 10;
    let bx = x + 12, by = y - h - 8;
    if (bx + w > p.x1) bx = x - w - 12;
    if (by < p.y0) by = y + 12;
    ctx.fillStyle = 'rgba(12,14,20,0.94)';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, bx, by, w, h, 6); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#e6e9f0';
    lines.forEach((l, k) => {
      ctx.fillStyle = k === 0 ? '#9aa3b8' : '#e6e9f0';
      ctx.fillText(l, bx + 8, by + 6 + k * 15);
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Accepts #rgb / #rrggbb and returns an rgba() string with the given alpha.
function hexA(hex, a) {
  hex = (hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex || '000000', 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
