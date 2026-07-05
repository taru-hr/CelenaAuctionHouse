# Celena Auction House

An [undermine.exchange](https://undermine.exchange/)-style price tracker for **World of Warcraft EU commodities** (crafting mats, consumables, gems, enchants — the region-wide auction market).

It sorts and filters every commodity, shows an **hourly price chart** per item, and flags when something is **cheaper than usual** so you can buy at the right time.

- 🖥️ **Frontend:** static HTML/CSS/JS, hosted free on **GitHub Pages**.
- ⚙️ **Backend:** a scheduled **GitHub Action** pulls the Blizzard API every hour — no server to run.
- 💾 **Storage:** compact JSON kept on a dedicated `data` branch (a single, always-overwritten commit, so it never bloats the repo).

> **Live site:** `https://<your-username>.github.io/CelenaAuctionHouse/`

---

## How it works

```
        ┌─────────────────────── every hour (cron) ───────────────────────┐
        │                                                                   │
  update-data.yml ──► Blizzard OAuth ──► /auctions/commodities (EU)         │
        │                    │                                              │
        │                    ├─► cheapest price + market price + quantity   │
        │                    ├─► append one point to each item's history    │
        │                    └─► refresh item names / icons (cached)        │
        │                                                                   │
        └──► force-push compact JSON to the `data` branch ─────────────────┘
                                   │
                                   ▼
                    deploy.yml  (runs after each data update, and on code pushes)
                                   │  assembles app files + latest data
                                   ▼
                        GitHub Pages  ◄────────  your browser (vanilla JS)
```

Retail commodities are **region-wide**, so a single EU dataset already covers **every EU realm** — there's no per-realm split to worry about (yet — see [Roadmap](#roadmap)).

---

## Setup (one-time, ~10 minutes)

### 1. Create free Blizzard API credentials
1. Go to **<https://develop.battle.net/access/clients>** and sign in with your Battle.net account.
2. Click **Create Client**. Name it anything (e.g. `celena-ah`); the redirect URL / service URL can be `https://localhost`.
3. Copy the **Client ID** and **Client Secret**. (Keep the secret private — never commit it.)

### 2. Put this project on GitHub
Create a **new repository named `CelenaAuctionHouse`** on GitHub (empty, no README), then push:

```bash
git add .
git commit -m "Celena Auction House"
git branch -M main
git remote add origin https://github.com/<your-username>/CelenaAuctionHouse.git
git push -u origin main
```

> Your personal `username.github.io` site is separate — this deploys as a **project page** at
> `https://<your-username>.github.io/CelenaAuctionHouse/`, which is exactly what we want.

### 3. Add the credentials as repository secrets
In your repo: **Settings → Secrets and variables → Actions → New repository secret**. Add two:

| Name | Value |
| --- | --- |
| `BLIZZARD_CLIENT_ID` | your Client ID |
| `BLIZZARD_CLIENT_SECRET` | your Client Secret |

### 4. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Source = GitHub Actions.**

### 5. Do the first data run
**Actions** tab → **Update auction data** → **Run workflow**. The first run takes a few minutes (it fetches item names/icons for the first time; later runs are quick). When it finishes, `deploy.yml` publishes automatically.

Visit `https://<your-username>.github.io/CelenaAuctionHouse/` — you're live. From now on it refreshes **every hour** on its own.

> Until the first data run finishes, the site shows a small **sample dataset** so you can see the layout.

---

## Using it

- **Sort** by any column (Cheapest, Market, Quantity, 24h change, or **vs avg**). Click a header to flip the direction.
- **Search** by item name; **filter** by quality; tick **Deals only** to show items trading below their typical price.
- **Click an item** for its hourly price chart, 14-day low/avg/high, and a buy signal like *“Cheapest it's been in ~14 days.”*
- **Market price** = the volume-weighted price of the cheapest ~15% of supply (a stable, outlier-resistant number). **Cheapest** = the single lowest buyout.

---

## Local preview (optional)

No build step required. Any static server works. With **Git Bash** (ships with Perl) you don't even need Node/Python:

```bash
perl scripts/serve.pl 8123 .
# then open http://127.0.0.1:8123/
```

You can also run the fetcher locally if you have Node 18+:

```bash
BLIZZARD_CLIENT_ID=xxx BLIZZARD_CLIENT_SECRET=yyy npm run fetch:data
```

---

## Configuration

Edit the `env:` block in [`.github/workflows/update-data.yml`](.github/workflows/update-data.yml):

| Variable | Default | Meaning |
| --- | --- | --- |
| `WOW_REGION` | `eu` | Region: `eu`, `us`, `kr`, `tw`. |
| `WOW_LOCALE` | `en_GB` | Language for item names (e.g. `en_US`, `de_DE`). |
| `HISTORY_DAYS` | `60` | How many days of hourly history to keep per item. |
| `MAX_NEW_META` | `2500` | Cap on new item-name lookups per run (the rest fill in on later runs). |

Change the schedule via the `cron:` line in the same file (default: hourly at `:07`).

---

## Data files (`data` branch)

| File | Shape |
| --- | --- |
| `latest.json` | `{ updated, region, count, items: [[id, cheapest, market, qty, pct24h, avg14d, low14d], …] }` |
| `meta.json` | `{ "<id>": { n: name, q: quality, i: iconUrl } }` |
| `history/<id>.json` | `{ t:[unixSec], p:[market], m:[cheapest], q:[qty] }` |
| `status.json` | run diagnostics (last update, item count, timing) |

All prices are in **copper** (1 gold = 100 silver = 10 000 copper).

---

## Roadmap

- **Per-realm items** (gear, BoEs, pets): add per-connected-realm snapshots with a realm selector. These aren't region-wide, so they need a rolling history window — or a free external database — to stay within GitHub's storage limits.
- Favorites / watchlist, deal alerts, and TSM-style deposit/craft calculations.

---

## Notes & limits

- Blizzard's AH data refreshes roughly once per hour, so hourly is the natural cadence.
- Scheduled GitHub Actions can be delayed a few minutes under load — that's fine here.
- The `data` branch is force-updated as a single commit each run, so the repo stays small.

## Credits

Data from the [Blizzard API](https://develop.battle.net/). Inspired by [undermine.exchange](https://undermine.exchange/).
Not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.
