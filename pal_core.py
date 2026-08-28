"""
Shared PAL scraping core — used by both the local dev server (serve.py) and the
Vercel serverless functions (api/data.py, api/player.py).

The name starts with "_", so Vercel does NOT turn this file into a route
(see the /api directory docs). Standard library only.

Session model is stateless (serverless-friendly): fetch_dataset() logs in and
returns the dataset plus the PAL cookie; the browser holds that cookie and
passes it back to fetch_player() for each match-history request. No server-side
session state, so it works identically on a single local process and on
ephemeral serverless instances.
"""

import base64
import concurrent.futures
import datetime
import gzip
import http.cookiejar
import json
import os
import re
import urllib.parse
import urllib.request

BASE = "https://www.poolplayersamateurleague.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")


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
    players = []
    for row in re.findall(r"<tr>(.*?)</tr>", block, re.S):
        tid = re.search(r"/league/team/(\d+)/", row)
        name = re.search(r'/league/team/\d+/">\s*(.*?)\s*</a>', row, re.S)
        nums = re.findall(r"<td[^>]*>\s*(-?\d+)\s*</td>", row)
        if not name or not tid or len(nums) < 5:
            continue
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


def _team_key(name):
    # order-insensitive identity: scotch teams appear with members in either
    # order ("ED A./BRANDON Y." vs "BRANDON Y./ED A."), so match by member set.
    return frozenset(re.sub(r"\s+", " ", p).strip().upper() for p in name.split("/") if p.strip())


def parse_matches(html, subject_name):
    subj_key = _team_key(subject_name)
    matches, subj_fargo = [], None

    for card in html.split('<div class="match-card')[1:]:
        p0 = card.find('class="players')
        s0 = card.find('class="score')
        if p0 == -1 or s0 == -1:
            continue
        b0 = card.find('class="bracket"')
        score_open = card.rfind("<div", 0, s0)
        score_end = card.rfind("<div", 0, b0) if b0 != -1 else len(card)
        players_txt = _strip(card[card.find(">", p0) + 1:score_open])
        score_txt = _strip(card[card.find(">", s0) + 1:score_end])

        pv = re.split(r"\bvs\b", players_txt, maxsplit=1)
        if len(pv) != 2:
            continue
        lname, lf = _name_fargo(pv[0])
        rname, rf = _name_fargo(pv[1])

        sv = re.split(r"\bto\b", score_txt, maxsplit=1)
        if len(sv) != 2:
            continue
        lscore, lbp = _side_score(sv[0])
        rscore, rbp = _side_score(sv[1])
        if lscore is None or rscore is None:
            continue

        dm = re.search(r'class="date hidden[^"]*">\s*Date:\s*([^<]+)<', card)
        date_label = dm.group(1).strip() if dm else None

        if _team_key(rname) == subj_key and _team_key(lname) != subj_key:
            # subject is on the right
            opp_name, opp_f, my, opp, my_f = lname, lf, rscore, lscore, rf
            my_bp, opp_bp = rbp or 0, lbp or 0
        else:
            # subject is on the left (exact/member match) or fallback
            opp_name, opp_f, my, opp, my_f = rname, rf, lscore, rscore, lf
            my_bp, opp_bp = lbp or 0, rbp or 0

        if subj_fargo is None and my_f is not None:
            subj_fargo = my_f
        matches.append({
            "date": date_label,
            "dateISO": _parse_date(date_label),
            "opponent": opp_name,
            "oppFargo": opp_f,
            "my": my, "opp": opp,
            # bonus points = games spotted on the wire to the LOWER-rated player;
            # they're included in the official score above, so games actually won
            # on the table = score - bp on that side.
            "myBp": my_bp, "oppBp": opp_bp,
            "result": "W" if my > opp else "L",
        })
    return {"fargo": subj_fargo, "matches": matches}


# ---------------------------------------------------------------------------
# Service account + refresh policy (Model B: open app, server-side scraping)
# ---------------------------------------------------------------------------
SERVICE_USER = os.environ.get("PAL_USER") or ""
SERVICE_PASS = os.environ.get("PAL_PASS") or ""
CRON_SECRET = os.environ.get("CRON_SECRET") or ""
COOLDOWN_SECONDS = 3600          # manual refresh: at most once per hour
_LEASE_SECONDS = 150             # a refresh in flight blocks others this long


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def build_snapshot():
    """Scrape everything with the service account: standings for every active
    league plus each player's match history. Returns one self-contained snapshot."""
    if not (SERVICE_USER and SERVICE_PASS):
        raise RuntimeError("Service account not configured (set PAL_USER / PAL_PASS).")
    client = Client()
    login(client, SERVICE_USER, SERVICE_PASS)
    dataset = build_dataset(client)
    cookie = client.cookie_header()

    players, seen = [], set()
    for key in dataset["order"]:
        for rows in dataset["leagues"][key]["brackets"].values():
            for r in rows:
                if r["team_id"] not in seen:
                    seen.add(r["team_id"]); players.append((r["team_id"], r["name"]))

    def one(p):
        # PAL throttles heavy concurrency (500s), so keep it modest and retry blips.
        tid, name = p
        for attempt in range(3):
            try:
                r = parse_matches(get_with_cookie(f"{BASE}/league/team/{tid}/", cookie), name)
                vals = [m["oppFargo"] for m in r["matches"] if m["oppFargo"] is not None]
                return str(tid), {"fargo": r["fargo"], "matches": r["matches"],
                                  "avgOpp": round(sum(vals) / len(vals), 1) if vals else None}
            except Exception:
                if attempt == 2:
                    return str(tid), None

    by_id = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for tid, val in ex.map(one, players):
            if val:
                by_id[tid] = val

    return {
        "fetchedAt": _now().isoformat(timespec="seconds"),
        "order": dataset["order"],
        "leagues": dataset["leagues"],
        "byId": by_id,
    }


# ---------------------------------------------------------------------------
# Shared snapshot cache.  Backend ladder:
#   1. Vercel KV / Upstash Redis over its REST API — shared + persistent, and
#      REQUIRED on Vercel (KV_REST_API_URL + KV_REST_API_TOKEN; stdlib HTTP)
#   2. a local file next to this module — local-dev persistence
# Values are gzip+base64 so they stay small and identical across backends.
# ---------------------------------------------------------------------------
# Upstash-for-Redis via the Vercel Marketplace injects KV_REST_API_*; accept the
# native Upstash names too, in case the integration uses those.
_KV_URL = (os.environ.get("KV_REST_API_URL")
           or os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
_KV_TOKEN = (os.environ.get("KV_REST_API_TOKEN")
             or os.environ.get("UPSTASH_REDIS_REST_TOKEN") or "")
_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".pal_cache")
_SNAP_KEY = "pal-snapshot"
_LEASE_KEY = "pal-lease"


def _kv_get(key):
    req = urllib.request.Request(f"{_KV_URL}/get/{key}",
                                 headers={"Authorization": f"Bearer {_KV_TOKEN}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode()).get("result")


def _kv_set(key, value):
    req = urllib.request.Request(
        f"{_KV_URL}/set/{key}", data=value.encode(),
        headers={"Authorization": f"Bearer {_KV_TOKEN}", "Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode()).get("result") == "OK"


def _backend_get(name):
    if _KV_URL and _KV_TOKEN:
        try:
            return _kv_get(name)
        except Exception:
            return None
    try:
        with open(os.path.join(_CACHE_DIR, name), encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def _backend_put(name, value):
    if _KV_URL and _KV_TOKEN:
        try:
            return _kv_set(name, value)
        except Exception:
            return False
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        with open(os.path.join(_CACHE_DIR, name), "w", encoding="utf-8") as f:
            f.write(value)
        return True
    except Exception:
        return False


def cache_get_snapshot():
    raw = _backend_get(_SNAP_KEY)
    if not raw:
        return None
    try:
        return json.loads(gzip.decompress(base64.b64decode(raw)).decode())
    except Exception:
        return None


def cache_put_snapshot(snapshot):
    blob = base64.b64encode(gzip.compress(json.dumps(snapshot).encode())).decode()
    return _backend_put(_SNAP_KEY, blob)


def snapshot_age_seconds():
    snap = cache_get_snapshot()
    if not snap or not snap.get("fetchedAt"):
        return None
    try:
        return (_now() - datetime.datetime.fromisoformat(snap["fetchedAt"])).total_seconds()
    except Exception:
        return None


def acquire_refresh_lease():
    """True if we may start a refresh; False if one is already in flight."""
    raw = _backend_get(_LEASE_KEY)
    if raw:
        try:
            if (_now() - datetime.datetime.fromisoformat(raw)).total_seconds() < _LEASE_SECONDS:
                return False
        except Exception:
            pass
    return _backend_put(_LEASE_KEY, _now().isoformat())


def do_refresh(is_cron):
    """Refresh the snapshot. Public callers are capped at once per COOLDOWN; the
    cron (is_cron) bypasses it. Returns (status_code, body_dict)."""
    if not is_cron:
        age = snapshot_age_seconds()
        if age is not None and age < COOLDOWN_SECONDS:
            return 429, {"error": "Data is already fresh — try again later.",
                         "retryAfterSec": int(COOLDOWN_SECONDS - age)}
        if not acquire_refresh_lease():
            return 429, {"error": "A refresh is already in progress — try again shortly.",
                         "retryAfterSec": 60}
    snapshot = build_snapshot()
    stored = cache_put_snapshot(snapshot)
    return 200, {"ok": True, "stored": stored, "fetchedAt": snapshot["fetchedAt"]}
