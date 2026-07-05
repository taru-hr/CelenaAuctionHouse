// Formatting helpers: WoW money (copper -> gold/silver/copper), quantities, time.

export function moneyParts(copper) {
  copper = Math.max(0, Math.round(copper || 0));
  return {
    g: Math.floor(copper / 10000),
    s: Math.floor(copper / 100) % 100,
    c: copper % 100,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Money as an HTML string with gold/silver/copper coloured spans. */
export function moneyHTML(copper) {
  const { g, s, c } = moneyParts(copper);
  let out = '';
  if (g) {
    out += `<span class="m-g">${g.toLocaleString()}</span><span class="m-s">${pad2(s)}</span><span class="m-c">${pad2(c)}</span>`;
  } else if (s) {
    out += `<span class="m-s">${s}</span><span class="m-c">${pad2(c)}</span>`;
  } else {
    out += `<span class="m-c">${c}</span>`;
  }
  return `<span class="money">${out}</span>`;
}

/** Plain-text money, e.g. "12g 05s 30c" — used for tooltips / titles. */
export function moneyText(copper) {
  const { g, s, c } = moneyParts(copper);
  if (g) return `${g.toLocaleString()}g ${pad2(s)}s ${pad2(c)}c`;
  if (s) return `${s}s ${pad2(c)}c`;
  return `${c}c`;
}

export function fmtQty(n) {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 100_000) return Math.round(n / 1000) + 'k';
  return n.toLocaleString();
}

export function fmtPct(p) {
  if (p == null) return '';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p}%`;
}

export function timeAgo(sec) {
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 0) return 'just now';
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

export function fmtDateShort(sec) {
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtDateTime(sec) {
  return new Date(sec * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
