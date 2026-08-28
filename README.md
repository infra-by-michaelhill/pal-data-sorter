# PAL Data Sorter

A tiny web app for browsing **Pool Players Amateur League** standings — runs
locally with one Python file, or deploys free to Vercel.

Sign in once with your PAL account and it pulls the standings for **whatever
leagues are currently active** — today that's *9 Ball 5th Season* (Bracket A + B)
and *9 Ball Scotch Doubles* — all at once. After that, switching league/bracket
and re-sorting is instant and offline, with one-click **CSV export**.

- **Nothing is hardcoded to a season.** The active seasons and each one's
  brackets are discovered live from the site, so it keeps working across
  season rollovers — singles or doubles, one bracket or two, any names.
- Sort by any meaningful column — **Points** (default), **Points / Match**,
  **Match Wins**, **Losses**, **Matches**, **Win %**, or player name.
- A league with two brackets lets you view **A**, **B**, or **Both** (with a
  bracket badge); a single-bracket league just shows its table.
- **Everything is shared-cached with one refresh.** The app always shows the
  latest data it has instantly, with an **"Updated 3h ago"** age at the top. A
  single **Refresh** (top bar, with a progress bar) re-pulls the standings *and*
  every player's match history in the background and republishes to the shared
  cache — so the next person just loads it, no waiting. The detail data adds
  sortable **Fargo** and **Avg Opp Fargo** columns and makes each row clickable
  → a **player page** with two tabs:
  - **Matches** — every match with the official score, the **spot** (bonus
    points), the rating you **played as** that match, and W/L; all sortable and
    CSV-exportable.
  - **Insights** — a **played-as rating for the session** (with a plain-English
    over/under verdict), **games won vs. Fargo-expected**, a **played-as
    line chart** vs your rating, and best-night / off-night highlights. Every
    number has an **ⓘ** explaining how it's derived.

  If it can't load, you get a normal message and the core standings are untouched.
- Light/dark theme, styled after the Crucible design system.
- No frameworks, no `pip install` — **Python standard library only**.

<br>

## Install & run

You only need **Python 3**. The installer checks for it and, if missing, points
you to (or on Windows offers to install) it. Then it drops a **desktop
shortcut** you double-click to launch the app.

### macOS
1. Download/clone this folder.
2. Double-click **`install-mac.command`**.
   - If macOS blocks it ("unidentified developer"), right-click → **Open** the
     first time, or run `xattr -d com.apple.quarantine install-mac.command`.
3. A **PAL Data Sorter** launcher appears on your Desktop — double-click it any
   time to start the app; your browser opens automatically.

### Windows
1. Download/clone this folder.
2. Double-click **`install-windows.bat`**.
   - If Python isn't installed, it tries `winget`; otherwise it opens the
     Python download page (check **"Add Python to PATH"** during install, then
     run the installer again).
3. A **PAL Data Sorter** shortcut appears on your Desktop — double-click it to
   start the app.

### Run it manually (any OS)
```bash
python3 serve.py --open      # or:  py -3 serve.py --open   on Windows
```
Then open <http://127.0.0.1:8765>. Leave the terminal window open while you use
it; press `Ctrl+C` to stop.

<br>

## Deploy free to Vercel

The app runs as a single Python function (declared in `vercel.json`) that serves
both the static frontend and the API, so it drops onto Vercel's free (Hobby)
tier and functions cold-start in ~1–2s.

1. Push this repo to GitHub (already done if you cloned it from there).
2. At [vercel.com/new](https://vercel.com/new), **Import** the repo.
3. Leave every setting at its default — `vercel.json` supplies the build/route
   config. No environment variables are needed.
4. **Deploy.** You'll get a URL like `https://pal-data-sorter.vercel.app`.

Or from the CLI: `npm i -g vercel && vercel` in this folder.

`vercel.json` builds `index.py` with the Python runtime and routes every request
to it; the handler serves the bundled static files and the `/api/*` endpoints.
Each new push to `main` redeploys.

### Shared granular cache (optional but recommended)

So users don't each re-scrape all the match pages, the granular data is cached
and shared. Backend, in order of preference:

1. **Vercel KV** (Upstash Redis) — shared across everyone and persistent. In the
   Vercel dashboard → **Storage → Create → KV**, attach it to the project. Vercel
   injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`; the app uses them over plain
   HTTPS (no SDK). Free tier is far more than enough.
2. **Local file** (`.pal_cache/`) — used automatically when there's no KV, so the
   cache persists across sessions when you run it locally.
3. **Nothing** — with no KV on Vercel, each browser just caches its own copy
   (shown as "this device only"); everything still works.

Writing to the shared cache requires a valid PAL login (the cookie is verified
against the site), so a stray visitor can't poison it.

> **Heads-up on hosting:** once it's on a public URL, anyone with the link who
> has a valid PAL account can use it, and their credentials transit Vercel's
> servers to reach the PAL site. It only ever touches their *own* PAL account,
> but keep the URL private and treat it as a personal tool. If PAL ever blocks
> requests from cloud IPs, run it locally instead.

<br>

## How it works

The browser can't log into the PAL site directly (cross-origin requests and the
site's Django CSRF flow both block it), so the backend performs the login, reads
the **active-seasons list** to discover which seasons exist, scrapes each one's
standings (detecting its brackets), and hands the browser the full dataset as
JSON plus a PAL session cookie. From then on the front end does all filtering
and sorting locally — no more live requests until you hit **Refresh**.

Granular data is loaded on demand: the browser asks `/api/player` for each team
(passing back the cookie from login), the backend parses that team's
match-history page, and the front end computes the averages and renders the
detail view — locally cached, so it's fetched at most once per session.

One request handler (`index.py`) serves both the static frontend and the API,
and the scraping core (`pal_core.py`) is shared, so local and hosted behave
identically — `serve.py` just runs that same handler locally.

```
index.py          the one entrypoint: handler serving static (GET) + /api (POST)
pal_core.py       shared PAL scraper (stdlib only): login, standings, matches
index.html        login screen + app shell           (served at / )
styles.css        Crucible-derived theme
app.js            data caching, sorting, granular loading, detail view, CSV export
serve.py          local dev server (imports index.py's handler; not deployed)
vercel.json       build + route config (Python runtime, catch-all to index.py)
install-mac.command / install-windows.bat   one-click local setup + desktop shortcut
```

There's nothing to change when seasons roll over — `discover_seasons()` reads
the site's active-seasons list and `parse_brackets()` detects each season's
bracket layout at fetch time.

<br>

## The Fargo insights — how they're derived

Nothing is made up; it's the published [FargoRate](https://fargorate.com/) model
(a 100-point rating gap ≈ winning **twice** as many games; ratings are the
maximum-likelihood fit to games won and lost).

- **Spots removed first.** Bonus points (BP) are games the lower-rated player is
  given on the wire, so games *actually won on the table* = official score − BP.
  All the math below uses on-table games.
- **Win chance per game:** `p = 2^(Δ/100) / (1 + 2^(Δ/100))`, where `Δ` is the
  Fargo gap. (Δ=100 → 66.7%, Δ=200 → 80%, Δ=0 → 50%.)
- **Played-as (one match):** `oppFargo + 100 · log₂(gamesWon / gamesLost)` — the
  rating that would produce that result against that opponent.
- **Played-as (session):** the rating where your **expected** game-wins equal
  your **actual** game-wins across the session — the same maximum-likelihood
  method FargoRate uses to compute ratings.
- **Expected games won:** your per-game win chance vs each opponent, summed.

These are single-player *performance estimates* from this league's games, not
official FargoRate ratings. Sources:
[FargoRate](https://fargorate.com/) ·
[Dr. Dave: FargoRate explained](https://drdavepoolinfo.com/faq/rating/fargorate/).

<br>

## Privacy

Locally, your credentials go only to `127.0.0.1` and are used once to log in to
the PAL site; nothing is written to disk. When deployed, they transit the host
(e.g. Vercel) to reach the PAL site, again only for that login. After login the
backend returns your PAL session cookie to the browser, which sends it back for
each match-history request — it's your own session, held in the browser, never
stored server-side. Checking **"Keep me signed in on this device"** stores your
credentials in the browser's `localStorage` (base64) so you don't retype them;
leave it unchecked and nothing persists. **Sign out** clears saved credentials
and cached data.

<br>

## License

MIT — see [LICENSE](LICENSE).
