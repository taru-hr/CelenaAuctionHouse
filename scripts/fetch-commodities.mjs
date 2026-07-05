#!/usr/bin/env node
/**
 * Celena Auction House — commodities fetcher.
 *
 * Runs on a schedule (GitHub Actions) or locally. It:
 *   1. Authenticates to the Blizzard API (OAuth client-credentials flow).
 *   2. Pulls the region-wide commodities auction snapshot.
 *   3. Reduces it to per-item { cheapest unit price, market price, quantity }.
 *   4. Appends one hourly point to each item's price-history file (pruning old points).
 *   5. Refreshes a cache of item names / icons / qualities for new items.
 *   6. Writes latest.json + status.json for the frontend.
 *
 * Retail commodities are REGION-WIDE, so one dataset covers every realm in the region.
 *
 * Required env: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET
 * Optional env:
 *   WOW_REGION      (default "eu")        e.g. eu | us | kr | tw
 *   WOW_LOCALE      (default "en_GB")     item-name language
 *   DATA_DIR        (default "data")      output directory
 *   HISTORY_DAYS    (default "60")        how many days of hourly history to keep
 *   MAX_NEW_META    (default "2500")      cap new item-metadata lookups per run
 *   NS_DYNAMIC      (default "dynamic-<region>")   auction namespace
 *   NS_STATIC       (default "static-<region>")    item/media namespace
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- config ---
const REGION = (process.env.WOW_REGION || 'eu').toLowerCase();
const LOCALE = process.env.WOW_LOCALE || 'en_GB';
const DATA_DIR = process.env.DATA_DIR || 'data';
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 60);
const MAX_NEW_META = Number(process.env.MAX_NEW_META || 2500);
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;

const OAUTH_HOST = REGION === 'cn' ? 'https://www.battlenet.com.cn' : 'https://oauth.battle.net';
const OAUTH_PATH = REGION === 'cn' ? '/oauth/token' : '/token';
const API_HOST = REGION === 'cn' ? 'https://gateway.battlenet.com.cn' : `https://${REGION}.api.blizzard.com`;
const NS_DYNAMIC = process.env.NS_DYNAMIC || `dynamic-${REGION}`;
const NS_STATIC = process.env.NS_STATIC || `static-${REGION}`;

// "Cheapest 15% of supply" — a stable, outlier-resistant market price (TSM-style).
const MARKET_DEPTH = 0.15;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET. Create a client at https://develop.battle.net/access/clients');
  process.exit(1);
}

// --------------------------------------------------------------- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

/** GET a Blizzard API endpoint as JSON, with retry/backoff on 429 + 5xx. */
async function apiGet(token, urlPath, namespace, extra = {}) {
  const url = new URL(API_HOST + urlPath);
  url.searchParams.set('namespace', namespace);
  url.searchParams.set('locale', LOCALE);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 404) return null; // e.g. item with no media
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }
    throw new Error(`GET ${urlPath} -> ${res.status} ${res.statusText}`);
  }
  throw new Error(`GET ${urlPath} failed after retries`);
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ auth ---
async function getToken() {
  const res = await fetch(OAUTH_HOST + OAUTH_PATH, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return json.access_token;
}

// ------------------------------------------------------------- pipeline ----
async function main() {
  const started = Date.now();
  await mkdir(HISTORY_DIR, { recursive: true });

  console.log(`[auth] requesting token (region=${REGION})`);
  const token = await getToken();

  console.log(`[fetch] commodities (namespace=${NS_DYNAMIC})`);
  const dump = await apiGet(token, '/data/wow/auctions/commodities', NS_DYNAMIC);
  const auctions = dump?.auctions ?? [];
  console.log(`[fetch] ${auctions.length.toLocaleString()} listings`);
  if (!auctions.length) throw new Error('No commodity listings returned — aborting so we do not overwrite good data.');

  // Group listings by item id.
  const byItem = new Map(); // id -> { listings: [[unit_price, qty]], total }
  for (const a of auctions) {
    const id = a.item?.id;
    if (!id) continue;
    let e = byItem.get(id);
    if (!e) byItem.set(id, (e = { listings: [], total: 0 }));
    e.listings.push([a.unit_price, a.quantity]);
    e.total += a.quantity;
  }

  // Per item: cheapest unit price, market price (cheapest MARKET_DEPTH of supply), total qty.
  const snapshot = new Map(); // id -> { min, market, qty }
  for (const [id, e] of byItem) {
    e.listings.sort((x, y) => x[0] - y[0]);
    const min = e.listings[0][0];
    const target = Math.max(1, e.total * MARKET_DEPTH);
    let acc = 0, cost = 0;
    for (const [price, qty] of e.listings) {
      const take = Math.min(qty, target - acc);
      cost += price * take;
      acc += take;
      if (acc >= target) break;
    }
    const market = Math.round(cost / acc);
    snapshot.set(id, { min, market, qty: e.total });
  }
  console.log(`[reduce] ${snapshot.size.toLocaleString()} distinct commodities`);

  const ts = nowSec();

  // ----- refresh item metadata (names / icons / quality) for items we don't know yet
  const meta = await readJson(path.join(DATA_DIR, 'meta.json'), {});
  const missing = [...snapshot.keys()].filter((id) => !meta[id] || !meta[id].n);
  const toFetch = missing.slice(0, MAX_NEW_META);
  if (toFetch.length) {
    console.log(`[meta] looking up ${toFetch.length} new items (${missing.length} missing total)`);
    await mapPool(toFetch, 20, async (id) => {
      const [item, media] = await Promise.all([
        apiGet(token, `/data/wow/item/${id}`, NS_STATIC).catch(() => null),
        apiGet(token, `/data/wow/media/item/${id}`, NS_STATIC).catch(() => null),
      ]);
      if (!item) return;
      const icon = media?.assets?.find((a) => a.key === 'icon')?.value || '';
      meta[id] = { n: item.name || `Item ${id}`, q: item.quality?.type || 'COMMON', i: icon };
    });
    await writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta));
  } else {
    console.log('[meta] cache is complete for this snapshot');
  }

  // ----- append one hourly point to each item's history (pruning old points),
  //       and compute per-item stats the table needs (24h change, 14d avg/low).
  const cutoff = ts - HISTORY_DAYS * 86400;
  const win14 = ts - 14 * 86400;
  const cut24 = ts - 86400;
  const entries = [...snapshot.entries()];
  const rows = new Array(entries.length);
  await mapPool(entries, 32, async ([id, s], idx) => {
    const file = path.join(HISTORY_DIR, `${id}.json`);
    const h = await readJson(file, { t: [], p: [], m: [], q: [] });
    h.t.push(ts); h.p.push(s.market); h.m.push(s.min); h.q.push(s.qty);
    // Prune anything older than the retention window.
    let cut = 0;
    while (cut < h.t.length && h.t[cut] < cutoff) cut++;
    if (cut > 0) { h.t = h.t.slice(cut); h.p = h.p.slice(cut); h.m = h.m.slice(cut); h.q = h.q.slice(cut); }
    await writeFile(file, JSON.stringify(h));

    // 24h change: latest market at or before 24h ago (fallback: oldest point).
    let past = h.p[0];
    for (let k = 0; k < h.t.length; k++) { if (h.t[k] <= cut24) past = h.p[k]; else break; }
    const pct24 = h.p.length > 1 && past > 0 ? Math.round(((s.market - past) / past) * 100) : null;

    // 14-day average + low over the market series.
    let sum = 0, n = 0, low = Infinity;
    for (let k = 0; k < h.t.length; k++) { if (h.t[k] >= win14) { const v = h.p[k]; sum += v; n++; if (v < low) low = v; } }
    const avg14 = n ? Math.round(sum / n) : s.market;
    const low14 = Number.isFinite(low) ? low : s.min;

    rows[idx] = [id, s.min, s.market, s.qty, pct24, avg14, low14];
  });
  console.log(`[history] updated ${rows.length.toLocaleString()} series`);

  // ----- latest.json: rows [id, min, market, qty, pct24, avg14, low14]
  await writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify({ updated: ts, region: REGION, count: rows.length, items: rows }));

  const status = {
    updated: ts,
    region: REGION,
    namespace: NS_DYNAMIC,
    items: rows.length,
    listings: auctions.length,
    metaCached: Object.keys(meta).length,
    metaMissing: Math.max(0, missing.length - toFetch.length),
    historyDays: HISTORY_DAYS,
    tookMs: Date.now() - started,
  };
  await writeFile(path.join(DATA_DIR, 'status.json'), JSON.stringify(status));
  console.log(`[done] ${status.items} items in ${(status.tookMs / 1000).toFixed(1)}s` +
    (status.metaMissing ? ` (${status.metaMissing} item names will fill in next run)` : ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
