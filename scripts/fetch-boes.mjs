#!/usr/bin/env node
/**
 * Celena Auction House — BoE (bind-on-equip gear) fetcher for one realm.
 *
 * Item level can't be derived from the auction API (it only gives bonus IDs),
 * and decoding it from ItemBonus.db2 is a deep rabbit hole (level selectors /
 * scaling curves). So we let Wowhead's tooltip API do the decoding: each
 * listing's bonus signature -> exact item level, cached by signature so we only
 * ask Wowhead once per distinct variant.
 *
 *   1. Resolve realm slug -> connected-realm id.
 *   2. Pull the realm's auctions; keep current-expansion equippable gear
 *      (BoP can't be auctioned, so anything equippable IS tradeable).
 *   3. Group listings by item id + bonus signature.
 *   4. Resolve each variant's item level via Wowhead (cached in boe-ilvlcache.json).
 *   5. Group by item + ilvl and record sorted buyouts for the flip radar.
 *
 * Required env: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET
 * Optional env: WOW_REGION(eu) WOW_LOCALE(en_GB) WOW_REALM_SLUG(ravencrest)
 *               DATA_DIR(data) MIN_ITEM_ID(234000) MAX_NEW_META(4000)
 *               MAX_NEW_ILVL(1500)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const REGION = (process.env.WOW_REGION || 'eu').toLowerCase();
const LOCALE = process.env.WOW_LOCALE || 'en_GB';
const REALM_SLUG = (process.env.WOW_REALM_SLUG || 'ravencrest').toLowerCase();
const DATA_DIR = process.env.DATA_DIR || 'data';
const MIN_ITEM_ID = Number(process.env.MIN_ITEM_ID || 234000);
const MAX_NEW_META = Number(process.env.MAX_NEW_META || 4000);
const MAX_NEW_ILVL = Number(process.env.MAX_NEW_ILVL || 1500); // Wowhead lookups per run
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;

const OAUTH_HOST = REGION === 'cn' ? 'https://www.battlenet.com.cn' : 'https://oauth.battle.net';
const OAUTH_PATH = REGION === 'cn' ? '/oauth/token' : '/token';
const API_HOST = REGION === 'cn' ? 'https://gateway.battlenet.com.cn' : `https://${REGION}.api.blizzard.com`;
const NS_DYNAMIC = `dynamic-${REGION}`;
const NS_STATIC = `static-${REGION}`;
const META_VERSION = 3;   // bumped when meta shape changes (added base ilvl)

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

/** Ask Wowhead's tooltip API for the item level of a specific bonus signature. */
async function wowheadIlvl(id, sig) {
  const url = `https://nether.wowhead.com/tooltip/item/${id}` + (sig ? `?bonus=${sig}` : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': 'CelenaAuctionHouse/1.0 (GitHub Pages hobby project)' } }); }
    catch { await sleep(400 * 2 ** attempt); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/Item Level\D{0,24}(\d{1,4})/); // tolerant of "<!--ilvl-->" / escaping
    return m ? Number(m[1]) : null;
  }
  return null;
}

async function main() {
  const started = Date.now();
  await mkdir(DATA_DIR, { recursive: true });
  const token = await getToken();

  const realm = await apiGet(token, `/data/wow/realm/${REALM_SLUG}`, NS_DYNAMIC);
  const crId = Number((String(realm?.connected_realm?.href || '').match(/connected-realm\/(\d+)/) || [])[1]);
  if (!crId) throw new Error(`Could not resolve connected realm for "${REALM_SLUG}"`);
  console.log(`[realm] ${REALM_SLUG} -> connected realm ${crId}`);

  console.log('[fetch] connected-realm auctions…');
  const dump = await apiGet(token, `/data/wow/connected-realm/${crId}/auctions`, NS_DYNAMIC);
  const auctions = dump?.auctions ?? [];
  console.log(`[fetch] ${auctions.length.toLocaleString()} listings`);
  if (!auctions.length) throw new Error('No auctions returned — aborting to avoid overwriting good data.');

  const midnight = auctions.filter((a) => a.item?.id >= MIN_ITEM_ID && a.buyout > 0);
  const ids = [...new Set(midnight.map((a) => a.item.id))];
  console.log(`[filter] ${midnight.length.toLocaleString()} Midnight listings across ${ids.length} item ids`);

  // item metadata (equippable? name? slot?) — cached, capped per run
  let meta = await readJson(path.join(DATA_DIR, 'boe-meta.json'), {});
  if (meta._v !== META_VERSION) { meta = { _v: META_VERSION }; console.log('[meta] schema changed — refetching all'); }
  const missingMeta = ids.filter((id) => meta[id] === undefined);
  const metaFetch = missingMeta.slice(0, MAX_NEW_META);
  if (metaFetch.length) {
    console.log(`[meta] looking up ${metaFetch.length} items (${missingMeta.length} missing)`);
    await mapPool(metaFetch, 20, async (id) => {
      const [item, media] = await Promise.all([
        apiGet(token, `/data/wow/item/${id}`, NS_STATIC).catch(() => null),
        apiGet(token, `/data/wow/media/item/${id}`, NS_STATIC).catch(() => null),
      ]);
      if (!item || !item.is_equippable) { meta[id] = null; return; }
      meta[id] = {
        n: item.name || `Item ${id}`,
        q: item.quality?.type || 'COMMON',
        i: media?.assets?.find((a) => a.key === 'icon')?.value || '',
        slot: item.inventory_type?.name || item.item_class?.name || '',
        base: item.preview_item?.level?.value ?? item.level ?? 0, // displayed base ilvl (clamp fallback)
      };
    });
    await writeFile(path.join(DATA_DIR, 'boe-meta.json'), JSON.stringify(meta));
  }

  // group listings by item id + bonus signature
  const bySig = new Map();
  for (const a of midnight) {
    if (!meta[a.item.id]) continue; // not equippable gear
    const sig = (a.item.bonus_lists || []).slice().sort((x, y) => x - y).join(':');
    const key = `${a.item.id}|${sig}`;
    let e = bySig.get(key);
    if (!e) bySig.set(key, (e = { id: a.item.id, sig, buyouts: [] }));
    e.buyouts.push(a.buyout);
  }
  console.log(`[group] ${bySig.size} distinct item+bonus variants`);

  // resolve item level per variant via Wowhead (cached by signature)
  const ilvlCache = await readJson(path.join(DATA_DIR, 'boe-ilvlcache.json'), {});
  const variants = [...bySig.values()];
  const toResolve = variants.filter((e) => ilvlCache[`${e.id}|${e.sig}`] === undefined).slice(0, MAX_NEW_ILVL);
  console.log(`[ilvl] resolving ${toResolve.length} new variants via Wowhead`);
  let resolved = 0;
  await mapPool(toResolve, 3, async (e) => {
    const ilvl = await wowheadIlvl(e.id, e.sig);
    ilvlCache[`${e.id}|${e.sig}`] = ilvl;
    if (ilvl != null) resolved++;
    await sleep(120); // be polite to Wowhead
  });
  await writeFile(path.join(DATA_DIR, 'boe-ilvlcache.json'), JSON.stringify(ilvlCache));
  console.log(`[ilvl] resolved ${resolved}/${toResolve.length}`);

  // attach each variant's resolved ilvl (0 = unresolved -> shown as "?")
  for (const e of variants) {
    const raw = ilvlCache[`${e.id}|${e.sig}`];
    e.ilvl = typeof raw === 'number' && raw > 0 ? raw : 0;
  }

  // Wowhead occasionally over-applies a scaling bonus and returns a value near
  // the item's bogus internal max (e.g. 603) while the game shows the base (86).
  // Detect it as a within-item outlier (>3x the item's cheapest resolved ilvl)
  // and clamp it back to the item's displayed base level.
  const minIlvl = new Map();
  for (const e of variants) {
    if (!e.ilvl) continue;
    const m = minIlvl.get(e.id);
    if (m === undefined || e.ilvl < m) minIlvl.set(e.id, e.ilvl);
  }
  let clamped = 0;
  for (const e of variants) {
    const base = meta[e.id]?.base || 0;
    if (e.ilvl && base && e.ilvl > minIlvl.get(e.id) * 3 && e.ilvl > base) { e.ilvl = base; clamped++; }
  }
  if (clamped) console.log(`[ilvl] clamped ${clamped} outlier variant(s) to item base`);

  // group by item id + ilvl (unresolved variants stay separate with ilvl 0)
  const groups = new Map();
  let pending = 0;
  for (const e of variants) {
    if (!e.ilvl) pending++;
    const key = e.ilvl ? `${e.id}:${e.ilvl}` : `${e.id}|${e.sig}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { id: e.id, ilvl: e.ilvl, buyouts: [] }));
    g.buyouts.push(...e.buyouts);
  }

  const items = [...groups.values()]
    .map((g) => { g.buyouts.sort((x, y) => x - y); return { i: g.id, l: g.ilvl, n: g.buyouts.length, p: g.buyouts.slice(0, 20) }; })
    .sort((a, b) => a.i - b.i || a.l - b.l);
  console.log(`[reduce] ${items.length} groups (${pending} variants still awaiting ilvl)`);

  const ts = nowSec();
  await writeFile(path.join(DATA_DIR, 'boe-latest.json'),
    JSON.stringify({ updated: ts, realm: REALM_SLUG, region: REGION, connectedRealm: crId, count: items.length, items }));
  await writeFile(path.join(DATA_DIR, 'boe-status.json'), JSON.stringify({
    updated: ts, realm: REALM_SLUG, connectedRealm: crId, listings: auctions.length,
    midnightListings: midnight.length, variants: variants.length, groups: items.length,
    ilvlPending: pending, metaCached: Object.keys(meta).length - 1,
    metaMissing: Math.max(0, missingMeta.length - metaFetch.length), tookMs: Date.now() - started,
  }));
  console.log(`[done] ${items.length} groups in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
