# PAL Data Sorter

A tiny local web app for browsing **Pool Players Amateur League** standings.

Sign in once with your PAL account and it pulls the standings for both current
leagues — **9 Ball 5th Season** (Bracket A + B) and **9 Ball Scotch Doubles** —
all at once. After that, switching league/bracket and re-sorting is instant and
offline, with one-click **CSV export**.

- Sort by any meaningful column — **Points** (default), **Points / Match**,
  **Match Wins**, **Losses**, **Matches**, **Win %**, or player name.
- Standard league lets you view **Bracket A**, **Bracket B**, or **Both**.
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
python3 app.py --open        # or:  py -3 app.py --open   on Windows
```
Then open <http://127.0.0.1:8765>. Leave the terminal window open while you use
it; press `Ctrl+C` to stop.

<br>

## How it works

The browser can't log into the PAL site directly (cross-origin requests and the
site's Django CSRF flow both block it), so a small local Python server
(`app.py`) performs the login and scrapes the season standings pages, then hands
the browser the full dataset as JSON. From then on the front end (`web/`) does
all filtering and sorting locally — no more live requests until you hit
**Refresh**.

```
app.py            local web server + PAL scraper (stdlib only)
web/index.html    login screen + app shell
web/styles.css    Crucible-derived theme
web/app.js        data caching, sorting, CSV export
install-mac.command / install-windows.bat   one-click setup + desktop shortcut
```

The seasons are pinned in `app.py` (`LEAGUES`); update those numbers when new
seasons start.

<br>

## Privacy

Your credentials are sent only to the local app (`127.0.0.1`) and used once to
log in to the PAL site for the fetch. The server never writes them to disk.
Checking **"Keep me signed in on this device"** stores them in your browser's
`localStorage` (base64, so they're not needed retyped next launch); leave it
unchecked and nothing is persisted. **Sign out** clears both the saved
credentials and the cached data.

<br>

## License

MIT — see [LICENSE](LICENSE).
