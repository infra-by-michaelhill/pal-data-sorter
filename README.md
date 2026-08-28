# PAL Data Sorter

An open, read-only web app for browsing **Pool Players Amateur League**
standings and per-player Fargo insights. No login — it shows a shared cached
snapshot that a scheduled job (and an hourly-capped manual refresh) keeps fresh.

- **Open & instant.** Anyone with the link sees the latest data immediately;
  the top bar shows how old it is ("Updated 3h ago").
- **One refresh.** A single top-bar **Refresh** re-scrapes everything in the
  background (progress bar) and republishes for everyone. It's **capped to once
  per hour** — enforced by the server, not just the button — so the PAL site is
  never hammered. A daily cron keeps it fresh with no clicks at all.
- **Nothing hardcoded to a season.** Active seasons and their brackets are
  discovered live, so it survives rollovers (singles or doubles, one bracket or
  two, any names).
- Sort by any column — **Points** (default), **Pts/Match**, **Match Wins**,
  **Losses**, **Matches**, **Win %**, **Fargo**, **Avg Opp Fargo**, or name.
- Click a player → a **player page** with **Matches** (with bonus-point spots and
  a per-match "played as" rating) and **Insights** (a session played-as rating,
  games-won-vs-expected, a played-as line chart, best/off-night). Every derived
  number has an **ⓘ** explaining it, from the FargoRate model.
- Light/dark theme, Crucible-styled. No frameworks, **Python standard library
  only** — nothing to `pip install`.

<br>

## Run it locally

You need **Python 3**. Viewing works from cached data; to refresh, set the
service account (any valid PAL login) in the environment:

```bash
PAL_USER='you@example.com' PAL_PASS='secret' python3 serve.py --open
```

Then open <http://127.0.0.1:8765> and click **Refresh** once to populate the
local cache (stored in `.pal_cache/`). Leave the terminal open; `Ctrl+C` to stop.
(The one-click `install-mac.command` / `install-windows.bat` create a desktop
launcher, but for refresh to work they'd need the env vars set — hosting on
Vercel is the intended way to run it for others.)

<br>

## Deploy free to Vercel

The whole app is one Python function (declared in `pyproject.toml`) that serves
the static frontend and the API. It fits the free (Hobby) tier.

1. Push this repo to GitHub and **Import** it at [vercel.com/new](https://vercel.com/new)
   (leave all settings at their defaults — `vercel.json` + `pyproject.toml`
   supply the config).
2. **Add a KV store** (Storage → Create → **KV**) and connect it to the project.
   This is **required** — it's the shared cache. Vercel injects
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Add environment variables** (Settings → Environment Variables):
   - `PAL_USER` / `PAL_PASS` — the service account that does the scraping.
   - `CRON_SECRET` — any random string; protects the daily cron trigger.
4. **Redeploy**, then hit **Refresh** once (or wait for the daily cron) to
   populate the cache.

`vercel.json` sets the function's `maxDuration` to 300s (a full refresh scrapes
~80 pages in ~60–90s, since PAL serializes requests) and registers a **daily**
cron (`0 8 * * *` UTC) at `/api/refresh`. Hobby crons only run daily; for a
faster cadence, trigger `/api/refresh` from a free external scheduler (e.g. a
GitHub Actions cron) — the once-per-hour server cooldown keeps it safe.

<br>

## How it works

Browsers can't log into the PAL site (cross-origin + Django CSRF), so all
scraping happens server-side with the service account:

- **`build_snapshot()`** logs in, discovers the active seasons, scrapes every
  bracket's standings and each player's match history, and returns one
  self-contained snapshot.
- **`/api/refresh`** stores that snapshot in the shared cache. The daily cron
  (with `CRON_SECRET`) always runs; the public button is **rate-limited to once
  per hour** and takes a short lease so simultaneous clicks can't double-scrape.
- **`/api/snapshot`** returns the cached snapshot; the frontend renders it and
  does all sorting/filtering locally.

```
index.py       WSGI entrypoint: serves static (GET) + /api/snapshot + /api/refresh
pal_core.py    scraper, FargoRate parsing, snapshot build, shared cache, cooldown
index.html     app shell (no login)      styles.css   Crucible theme
app.js         rendering, sorting, insights, chart, refresh + cooldown UI, CSV
serve.py       local dev server (runs the same WSGI app via wsgiref)
pyproject.toml Vercel entrypoint (index:app)   vercel.json  maxDuration + daily cron
```

<br>

## The Fargo insights — how they're derived

Straight from the published [FargoRate](https://fargorate.com/) model (a
100-point gap ≈ winning **twice** as many games; ratings are the
maximum-likelihood fit to games won and lost).

- **Spots removed first.** Bonus points (BP) are games the lower-rated player is
  given on the wire, so games actually won on the table = official score − BP.
- **Win chance per game:** `p = 2^(Δ/100) / (1 + 2^(Δ/100))` (Δ = Fargo gap).
- **Played-as (one match):** `oppFargo + 100·log₂(gamesWon / gamesLost)`.
- **Played-as (session):** the rating where your **expected** game-wins equal
  your **actual** ones — the same maximum-likelihood method FargoRate uses.

These are single-player performance estimates from this league's games, not
official FargoRate ratings. Sources: [FargoRate](https://fargorate.com/) ·
[Dr. Dave: FargoRate explained](https://drdavepoolinfo.com/faq/rating/fargorate/).

<br>

## Privacy & safety

No user accounts and no user credentials — viewers just read cached league data.
Only the **service account** (your env vars, never in code) ever contacts PAL,
at most once per hour, so the app can't be used to hammer PAL or test
credentials. The scraped data is public to anyone with the URL, so keep the link
to your group if you'd rather it stay private.

<br>

## License

MIT — see [LICENSE](LICENSE).
