#!/usr/bin/env python3
"""
PAL Data Sorter — a small local web app.

Logs into poolplayersamateurleague.com with the credentials you type on the
login screen, pulls the standings for whatever leagues are currently active
(discovered live — no season is hardcoded), and hands the browser the full
dataset at once. Choosing a league / bracket and re-sorting is all local.

Optionally, the app can load "granular data" — each player's match history
(date, opponent, opponent Fargo, score) — via /api/player. That powers the
per-player Fargo and average-opponent-Fargo columns and the opponent detail
view. It's loaded on demand behind a progress bar and never blocks the core
standings.

The browser cannot log into the PAL site itself (cross-origin + Django CSRF),
so the scrape runs here in Python. Standard library only — nothing to install
beyond Python itself. Your credentials are used only to log in for the fetch and
are never written to disk by this server.

Usage:
    python3 app.py                 # serve http://127.0.0.1:8765
    python3 app.py --open          # also open it in your browser
    python3 app.py --port 9000
"""

import argparse
import datetime
import http.cookiejar
import json
import os
import re
import secrets
import socket
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "https://www.poolplayersamateurleague.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Nothing about the seasons is hardcoded — the active seasons and their brackets
# are discovered at fetch time (see discover_seasons / parse_brackets), so this
# keeps working when the seasons roll over, whether they're singles or doubles
# and whether each has one bracket or two.

# token -> Cookie header string for an authenticated session. Lets /api/player
# reuse the login from /api/data without re-authenticating, and stays thread-safe
# because each request builds its own urllib request with a static Cookie header.
_SESSIONS = {}
_SESSIONS_MAX = 8


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------
class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))

    def get(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with self.opener.open(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")

    def post(self, url, data, referer):
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=body, headers={
            "User-Agent": UA, "Referer": referer, "Origin": BASE,
            "Content-Type": "application/x-www-form-urlencoded"})
        with self.opener.open(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")

    def cookie(self, name):
        return next((c.value for c in self.jar if c.name == name), None)

    def cookie_header(self):
        return "; ".join(f"{c.name}={c.value}" for c in self.jar)


def get_with_cookie(url, cookie_header):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Cookie": cookie_header})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def login(client, username, password):
    url = f"{BASE}/league/login/?next=%2Fleague%2F"
    m = re.search(r'name="csrfmiddlewaretoken"\s+value="([^"]+)"', client.get(url))
    if not m:
        raise RuntimeError("Could not find the login form on the PAL site.")
    html = client.post(url, {
        "csrfmiddlewaretoken": m.group(1), "next": "/league/",
        "username": username, "password": password}, referer=url)
    if client.cookie("sessionid") is None or "Logout" not in html:
        raise RuntimeError("Login failed — check your email and password.")


# ---------------------------------------------------------------------------
# Standings parsing
# ---------------------------------------------------------------------------
def _rows_from_tbody(block):
    """Extract standings rows from a <tbody> block, or [] if it isn't one."""
    players = []
    for row in re.findall(r"<tr>(.*?)</tr>", block, re.S):
        tid = re.search(r"/league/team/(\d+)/", row)
        name = re.search(r'/league/team/\d+/">\s*(.*?)\s*</a>', row, re.S)
        nums = re.findall(r"<td[^>]*>\s*(-?\d+)\s*</td>", row)
        if not name or not tid or len(nums) < 5:
            continue
        # numeric cells in order: rank, GP, MW, ML, MP
        gp, mw, ml, mp = int(nums[1]), int(nums[2]), int(nums[3]), int(nums[4])
        players.append({
            "team_id": int(tid.group(1)),
            "name": re.sub(r"\s+", " ", name.group(1)).strip(),
            "GP": gp, "MW": mw, "ML": ml, "MP": mp,
            "GPMP": round(gp / mp, 2) if mp else None,
            "winPct": round(100 * mw / mp, 1) if mp else None,
        })
    return players


def parse_brackets(html):
    """Return {bracket_label: [rows]} for every standings table on a season page.

    Discovered from the page, so it adapts to whatever exists: a two-bracket
    season yields {'A': [...], 'B': [...]}; a single-bracket (singles or scotch)
    season yields {'Main': [...]}. Any additional unlabeled tables fall back to
    'Group 1', 'Group 2', … so nothing is silently dropped.
    """
    tables = []
    for m in re.finditer(r"<tbody[^>]*>(.*?)</tbody>", html, re.S):
        if "/league/team/" not in m.group(1):
            continue
        rows = _rows_from_tbody(m.group(1))
        if not rows:
            continue
        letters = re.findall(r"BRACKET\s+([A-Z])\b", html[:m.start()])
        tables.append((letters[-1] if letters else None, rows))

    brackets, unlabeled = {}, 0
    single = len(tables) == 1
    for label, rows in tables:
        if label is None:
            unlabeled += 1
            label = "Main" if single else f"Group {unlabeled}"
        key, n = label, 2
        while key in brackets:
            key = f"{label} ({n})"; n += 1
        brackets[key] = rows
    return brackets


SEASON_LINK = re.compile(r"/league/season/(\d+)/")
H2 = re.compile(r"<h2[^>]*>\s*(.*?)\s*</h2>", re.S)


def _clean_name(raw):
    name = re.sub(r"<[^>]+>", "", raw)
    name = re.sub(r"\s+", " ", name).strip()
    return re.sub(r"^PAL\s+", "", name, flags=re.I)


def discover_seasons(client):
    """Scrape the active-seasons list into [{'season': id, 'name': str}, ...]
    in the order the site presents them. Not hardcoded, so it follows rollovers.
    """
    html = client.get(f"{BASE}/league/seasons/")
    seasons, seen = [], set()
    for m in SEASON_LINK.finditer(html):
        sid = int(m.group(1))
        if sid in seen:
            continue
        seen.add(sid)
        name = None
        for head in H2.findall(html[:m.start()]):
            txt = _clean_name(head)
            if txt and not re.match(r"(venue|@|active seasons)", txt, re.I):
                name = txt
        seasons.append({"season": sid, "name": name or f"Season {sid}"})
    return seasons


def build_dataset(client):
    """Build the standings dataset from an already-logged-in client."""
    seasons = discover_seasons(client)
    if not seasons:
        raise RuntimeError("No active seasons found on the PAL site.")
    leagues, order = {}, []
    for s in seasons:
        html = client.get(f"{BASE}/league/season/{s['season']}/")
        brackets = parse_brackets(html)
        if not brackets:
            continue
        key = f"s{s['season']}"
        order.append(key)
        leagues[key] = {"name": s["name"], "season": s["season"], "brackets": brackets}
    if not leagues:
        raise RuntimeError("Active seasons were found but none have standings yet.")
    return {
        "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "order": order,
        "leagues": leagues,
    }


# ---------------------------------------------------------------------------
# Match-history parsing (granular data)
# ---------------------------------------------------------------------------
def _name_fargo(text):
    f = re.search(r"\((\d{3,4})\)", text)
    name = re.sub(r"\(\d{3,4}\)", "", text)
    return re.sub(r"\s+", " ", name).strip(), (int(f.group(1)) if f else None)


def _side_score(text):
    """From one side's text like '(2 BP) 5' -> (game_score, break_points)."""
    bp = re.search(r"\((\d+)\s*BP\)", text)
    g = re.search(r"-?\d+", re.sub(r"\(\d+\s*BP\)", " ", text))
    return (int(g.group()) if g else None, int(bp.group(1)) if bp else None)


def _parse_date(label):
    if not label:
        return None
    try:
        return datetime.datetime.strptime(
            label.strip(), "%a, %b %d, %Y %I:%M %p").isoformat()
    except ValueError:
        return None


def _strip(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def parse_matches(html, subject_name):
    """Parse a team page's match history for one player/team.

    Returns {'fargo': subject_rating_or_None, 'matches': [ {...} ]} where each
    match has date, opponent, opponent Fargo, the player's and opponent's game
    scores, and W/L. Works identically for singles and scotch doubles.
    """
    subj = re.sub(r"\s+", " ", subject_name).strip().upper()
    matches, subj_fargo = [], None

    for card in html.split('<div class="match-card')[1:]:
        p0 = card.find('class="players')
        s0 = card.find('class="score')
        if p0 == -1 or s0 == -1:
            continue
        b0 = card.find('class="bracket"')
        # slice each region to the start of the *next* block's opening <div, so a
        # partial (unclosed) tag never leaks into the stripped text.
        score_open = card.rfind("<div", 0, s0)
        score_end = card.rfind("<div", 0, b0) if b0 != -1 else len(card)
        players_txt = _strip(card[card.find(">", p0) + 1:score_open])
        score_txt = _strip(card[card.find(">", s0) + 1:score_end])

        # players: "LEFT NAME (fargo) vs RIGHT NAME (fargo)"
        pv = re.split(r"\bvs\b", players_txt, maxsplit=1)
        if len(pv) != 2:
            continue
        lname, lf = _name_fargo(pv[0])
        rname, rf = _name_fargo(pv[1])

        # score: "LEFT to RIGHT" (either side may carry a "(n BP)")
        sv = re.split(r"\bto\b", score_txt, maxsplit=1)
        if len(sv) != 2:
            continue  # unscored / upcoming match — skip
        lscore, lbp = _side_score(sv[0])
        rscore, rbp = _side_score(sv[1])
        if lscore is None or rscore is None:
            continue

        dm = re.search(r'class="date hidden[^"]*">\s*Date:\s*([^<]+)<', card)
        date_label = dm.group(1).strip() if dm else None

        if lname.upper() == subj:
            opp_name, opp_f, my, opp, my_bp, opp_bp, my_f = rname, rf, lscore, rscore, lbp, rbp, lf
        elif rname.upper() == subj:
            opp_name, opp_f, my, opp, my_bp, opp_bp, my_f = lname, lf, rscore, lscore, rbp, lbp, rf
        else:
            # couldn't match the subject by name; assume the left side is them
            opp_name, opp_f, my, opp, my_bp, opp_bp, my_f = rname, rf, lscore, rscore, lbp, rbp, lf

        if subj_fargo is None and my_f is not None:
            subj_fargo = my_f
        matches.append({
            "date": date_label,
            "dateISO": _parse_date(date_label),
            "opponent": opp_name,
            "oppFargo": opp_f,
            "my": my, "opp": opp,
            "myBp": my_bp, "oppBp": opp_bp,
            "result": "W" if my > opp else "L",
        })
    return {"fargo": subj_fargo, "matches": matches}


# ---------------------------------------------------------------------------
# Web server
# ---------------------------------------------------------------------------
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not target.startswith(WEB_DIR) or not os.path.isfile(target):
            self._send(404, json.dumps({"error": "not found"}))
            return
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as f:
            self._send(200, f.read(),
                       CONTENT_TYPES.get(ext, "application/octet-stream"))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._send(400, json.dumps({"error": "Bad request."}))
            return

        if path == "/api/data":
            self._handle_data(req)
        elif path == "/api/player":
            self._handle_player(req)
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def _handle_data(self, req):
        try:
            user = (req.get("user") or "").strip()
            pw = req.get("password") or ""
            if not user or not pw:
                raise ValueError("Email and password are required.")
            client = Client()
            login(client, user, pw)
            dataset = build_dataset(client)
            token = secrets.token_hex(16)
            _SESSIONS[token] = client.cookie_header()
            while len(_SESSIONS) > _SESSIONS_MAX:
                _SESSIONS.pop(next(iter(_SESSIONS)))
            dataset["token"] = token
            self._send(200, json.dumps(dataset))
        except Exception as e:  # noqa: BLE001
            self._send(400, json.dumps({"error": str(e)}))

    def _handle_player(self, req):
        try:
            token = req.get("token") or ""
            cookie = _SESSIONS.get(token)
            if not cookie:
                raise RuntimeError("Session expired — sign in again.")
            team_id = int(req.get("team_id"))
            name = req.get("name") or ""
            html = get_with_cookie(f"{BASE}/league/team/{team_id}/", cookie)
            result = parse_matches(html, name)
            result["team_id"] = team_id
            self._send(200, json.dumps(result))
        except (TypeError, ValueError):
            self._send(400, json.dumps({"error": "Invalid player id."}))
        except Exception as e:  # noqa: BLE001
            self._send(400, json.dumps({"error": str(e)}))

    def log_message(self, *_):
        pass


def _port_in_use(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) == 0


def main():
    ap = argparse.ArgumentParser(description="PAL Data Sorter local web app")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--open", action="store_true", help="open in browser on start")
    args = ap.parse_args()

    url = f"http://{args.host}:{args.port}/"
    if _port_in_use(args.host, args.port):
        print(f"PAL Data Sorter already running at {url}")
        if args.open:
            webbrowser.open(url)
        return

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PAL Data Sorter running at {url}")
    print("Leave this window open while you use it. Press Ctrl+C to stop.")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
