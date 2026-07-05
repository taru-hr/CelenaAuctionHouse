// Data loading. All paths are relative so the site works under any GitHub Pages
// subpath (e.g. https://<user>.github.io/CelenaAuctionHouse/) with no config.

const BASE = 'data/';
const historyCache = new Map();

async function getJSON(path) {
  const res = await fetch(BASE + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Load the table dataset: status + latest snapshot + item metadata. */
export async function loadIndex() {
  const [status, latest, meta] = await Promise.all([
    getJSON('status.json').catch(() => null),
    getJSON('latest.json'),
    getJSON('meta.json').catch(() => ({})),
  ]);
  return { status, latest, meta };
}

/** Load one item's hourly history (cached in-memory for the session). */
export async function loadHistory(id) {
  if (historyCache.has(id)) return historyCache.get(id);
  const data = await getJSON(`history/${id}.json`).catch(() => null);
  historyCache.set(id, data);
  return data;
}
