#!/usr/bin/env node
/**
 * Celena Auction House — BoE (bind-on-equip gear) fetcher for one realm.
 *
 * Commodities barely flip; mispriced BoE gear does. This:
 *   1. Resolves a realm slug -> connected-realm id.
 *   2. Loads a bonus-id -> item-level-delta map (datamined ItemBonus.db2 via
 *      wago.tools), cached and refreshed weekly.
 *   3. Pulls the connected realm's auctions, keeps current-expansion equippable
 *      gear (BoP items can't be auctioned, so anything equippable IS tradeable).
 *   4. Computes each listing's item level = base ilvl + Type-1 bonus deltas.
 *   5. Groups by (item id + ilvl) and records the sorted buyouts, so the frontend
 *      can flag a listing sitting far below the rest of its item+ilvl.
 *
 * Required env: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET
 * Optional env: WOW_REGION(eu) WOW_LOCALE(en_GB) WOW_REALM_SLUG(ravencrest)
 *               DATA_DIR(data) MIN_ITEM_ID(234000) MAX_NEW_META(4000)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const REGION = (process.env.WOW_REGION || 'eu').toLowerCase();
const LOCALE = process.env.WOW_LOCALE || 'en_GB';
const REALM_SLUG = (process.env.WOW_REALM_SLUG || 'ravencrest').toLowerCase();
const DATA_DIR = process.env.DATA_DIR || 'data';
const MIN_ITEM_ID = Number(process.env.MIN_ITEM_ID || 234000); // current-expansion cutoff
const MAX_NEW_META = Number(process.env.MAX_NEW_META || 4000);
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;

const OAUTH_HOST = REGION === 'cn' ? 'https://www.battlenet.com.cn' : 'https://oauth.battle.net';
const OAUTH_PATH = REGION === 'cn' ? '/oauth/token' : '/token';
const API_HOST = REGION === 'cn' ? 'https://gateway.battlenet.com.cn' : `https://${REGION}.api.blizzard.com`;
const NS_DYNAMIC = `dynamic-${REGION}`;
const NS_STATIC = `static-${REGION}`;
const BONUS_CSV = 'https://wago.tools/db2/ItemBonus/csv';
const BONUS_TTL = 7 * 86400; // refresh the datamined bonus map weekly

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function getToken() {
  const res = await fetch(OAUTH_HOST + OAUTH_PATH, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function apiGet(token, urlPath, namespace, extra = {}) {
  const url = new URL(API_HOST + urlPath);
  url.searchParams.set('namespace', namespace);
  url.searchParams.set('locale', LOCALE);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
    catch { await sleep(500 * 2 ** attempt); continue; }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra ? ra * 1000 : 500 * 2 ** attempt);
      continue;
    }
    throw new Error(`GET ${urlPath} -> ${res.status}`);
  }
  throw new Error(`GET ${urlPath} failed after retries`);
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- bonus-id -> item-level delta (datamined, cached weekly) --------------
async function loadBonusMap() {
  const file = path.join(DATA_DIR, 'boe-bonusmap.json');
  const cached = await readJson(file, null);
  if (cached && cached._fetched && nowSec() - cached._fetched < BONUS_TTL) {
    console.log(`[bonus] using cached map (${Object.keys(cached.map).length} ilvl bonuses)`);
    return cached.map;
  }
  console.log('[bonus] downloading ItemBonus from wago.tools…');
  const res = await fetch(BONUS_CSV);
  if (!res.ok) {
    if (cached) { console.warn('[bonus] download failed, reusing stale cache'); return cached.map; }
    throw new Error(`ItemBonus download failed: ${res.status}`);
  }
  const text = await res.text();
  // header: ID,Value_0,Value_1,Value_2,Value_3,ParentItemBonusListID,Type,OrderIndex
  const map = {};
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 7 || c[6] !== '1') continue; // Type 1 = item level delta
    const bonus = c[5];
    map[bonus] = (map[bonus] || 0) + (parseInt(c[1], 10) || 0); // Value_0
  }
  await writeFile(file, JSON.stringify({ _fetched: nowSec(), map }));
  console.log(`[bonus] built map for ${Object.keys(map).length} ilvl bonuses`);
  return map;
}

async function main() {
  const started = Date.now();
  await mkdir(DATA_DIR, { recursive: true });
  const token = await getToken();

  // 1) realm slug -> connected realm id
  const realm = await apiGet(token, `/data/wow/realm/${REALM_SLUG}`, NS_DYNAMIC);
  const href = realm?.connected_realm?.href || '';
  const crId = Number((href.match(/connected-realm\/(\d+)/) || [])[1]);
  if (!crId) throw new Error(`Could not resolve connected realm for "${REALM_SLUG}"`);
  console.log(`[realm] ${REALM_SLUG} -> connected realm ${crId}`);

  const bonusMap = await loadBonusMap();

  // 2) pull the realm's auctions
  console.log('[fetch] connected-realm auctions…');
  const dump = await apiGet(token, `/data/wow/connected-realm/${crId}/auctions`, NS_DYNAMIC);
  const auctions = dump?.auctions ?? [];
  console.log(`[fetch] ${auctions.length.toLocaleString()} listings`);
  if (!auctions.length) throw new Error('No auctions returned — aborting to avoid overwriting good data.');

  // 3) keep current-expansion listings that have a buyout
  const midnight = auctions.filter((a) => a.item?.id >= MIN_ITEM_ID && a.buyout > 0);
  const ids = [...new Set(midnight.map((a) => a.item.id))];
  console.log(`[filter] ${midnight.length.toLocaleString()} Midnight listings across ${ids.length} item ids`);

  // 4) item metadata (equippable? base ilvl? slot?) — cached, capped per run.
  //    Bump META_VERSION when the meta shape changes to force a full refetch.
  const META_VERSION = 2;
  let meta = await readJson(path.join(DATA_DIR, 'boe-meta.json'), {});
  if (meta._v !== META_VERSION) { meta = { _v: META_VERSION }; console.log('[meta] schema changed — refetching all'); }
  const missing = ids.filter((id) => meta[id] === undefined);
  const toFetch = missing.slice(0, MAX_NEW_META);
  if (toFetch.length) {
    console.log(`[meta] looking up ${toFetch.length} items (${missing.length} missing)`);
    await mapPool(toFetch, 20, async (id) => {
      const [item, media] = await Promise.all([
        apiGet(token, `/data/wow/item/${id}`, NS_STATIC).catch(() => null),
        apiGet(token, `/data/wow/media/item/${id}`, NS_STATIC).catch(() => null),
      ]);
      if (!item) { meta[id] = null; return; }                       // remember misses
      if (!item.is_equippable) { meta[id] = null; return; }         // gear only
      meta[id] = {
        n: item.name || `Item ${id}`,
        q: item.quality?.type || 'COMMON',
        i: media?.assets?.find((a) => a.key === 'icon')?.value || '',
        // Use the DISPLAYED item level; the top-level `item.level` is an internal
        // value (e.g. 662) that's wrong for scaling/raid gear.
        base: item.preview_item?.level?.value ?? item.level ?? 0,
        slot: item.inventory_type?.name || item.item_class?.name || '',
      };
    });
    await writeFile(path.join(DATA_DIR, 'boe-meta.json'), JSON.stringify(meta));
  }

  // 5) compute ilvl per listing, group by item id + ilvl
  const groups = new Map(); // "id:ilvl" -> { id, ilvl, buyouts: [] }
  for (const a of midnight) {
    const m = meta[a.item.id];
    if (!m) continue; // not equippable gear (or metadata not fetched yet)
    let ilvl = m.base;
    for (const b of a.item.bonus_lists || []) ilvl += bonusMap[b] || 0;
    const key = `${a.item.id}:${ilvl}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { id: a.item.id, ilvl, buyouts: [] }));
    g.buyouts.push(a.buyout);
  }

  const items = [...groups.values()]
    .map((g) => {
      g.buyouts.sort((x, y) => x - y);
      return { i: g.id, l: g.ilvl, n: g.buyouts.length, p: g.buyouts.slice(0, 20) };
    })
    .sort((a, b) => a.i - b.i || a.l - b.l);
  console.log(`[reduce] ${items.length} item+ilvl groups`);

  const ts = nowSec();
  await writeFile(path.join(DATA_DIR, 'boe-latest.json'),
    JSON.stringify({ updated: ts, realm: REALM_SLUG, region: REGION, connectedRealm: crId, count: items.length, items }));
  await writeFile(path.join(DATA_DIR, 'boe-status.json'), JSON.stringify({
    updated: ts, realm: REALM_SLUG, connectedRealm: crId, listings: auctions.length,
    midnightListings: midnight.length, groups: items.length,
    metaCached: Object.keys(meta).length, metaMissing: Math.max(0, missing.length - toFetch.length),
    tookMs: Date.now() - started,
  }));
  console.log(`[done] ${items.length} groups in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
