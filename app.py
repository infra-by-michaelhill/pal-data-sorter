#!/usr/bin/env python3
"""
PAL Data Sorter — a small local web app.

Logs into poolplayersamateurleague.com with the credentials you type on the
login screen, pulls the standings for both available leagues (9 Ball 5th Season
and 9 Ball Scotch Doubles) including every bracket, and hands the whole dataset
to the browser at once. From there, choosing a league / bracket and re-sorting
is all local — no further live queries — with one-click CSV export.

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

# The two leagues that currently exist. Seasons are locked here so the UI never
# has to ask for a season number.
LEAGUES = [
    {"key": "standard", "name": "9 Ball 5th Season",     "season": 7},
    {"key": "scotch",   "name": "9 Ball Scotch Doubles", "season": 6},
]


# ---------------------------------------------------------------------------
# Scraper
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


def _rows_from_tbody(block):
    """Extract standings rows from a <tbody> block, or [] if it isn't one."""
    players = []
    for row in re.findall(r"<tr>(.*?)</tr>", block, re.S):
        name = re.search(r'/league/team/\d+/">\s*(.*?)\s*</a>', row, re.S)
        nums = re.findall(r"<td[^>]*>\s*(-?\d+)\s*</td>", row)
        if not name or len(nums) < 5:
            continue
        # numeric cells in order: rank, GP, MW, ML, MP
        gp, mw, ml, mp = int(nums[1]), int(nums[2]), int(nums[3]), int(nums[4])
        players.append({
            "name": re.sub(r"\s+", " ", name.group(1)).strip(),
            "GP": gp, "MW": mw, "ML": ml, "MP": mp,
            "GPMP": round(gp / mp, 2) if mp else None,
            "winPct": round(100 * mw / mp, 1) if mp else None,
        })
    return players


def parse_brackets(html):
    """Return {bracket_label: [rows]} for every standings table on a season page.

    Standard seasons have BRACKET A and BRACKET B; Scotch Doubles has a single
    table with no bracket label (returned under 'Main').
    """
    brackets = {}
    for m in re.finditer(r"<tbody[^>]*>(.*?)</tbody>", html, re.S):
        if "/league/team/" not in m.group(1):
            continue
        rows = _rows_from_tbody(m.group(1))
        if not rows:
            continue
        preceding = re.findall(r"BRACKET\s+([A-Z])\b", html[:m.start()])
        label = preceding[-1] if preceding else "Main"
        brackets[label] = rows
    return brackets


def build_dataset(username, password):
    client = Client()
    login(client, username, password)
    leagues = {}
    for lg in LEAGUES:
        html = client.get(f"{BASE}/league/season/{lg['season']}/")
        leagues[lg["key"]] = {
            "name": lg["name"], "season": lg["season"],
            "brackets": parse_brackets(html),
        }
    return {
        "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "order": [lg["key"] for lg in LEAGUES],
        "leagues": leagues,
    }


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
        if urllib.parse.urlparse(self.path).path != "/api/data":
            self._send(404, json.dumps({"error": "not found"}))
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            user = (req.get("user") or "").strip()
            pw = req.get("password") or ""
            if not user or not pw:
                raise ValueError("Email and password are required.")
            self._send(200, json.dumps(build_dataset(user, pw)))
        except Exception as e:  # noqa: BLE001 — surface the message to the UI
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

    # If it's already running (e.g. the desktop shortcut was clicked twice),
    # just point the browser at the existing instance.
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
