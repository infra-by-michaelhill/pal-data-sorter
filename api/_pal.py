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

import datetime
import http.cookiejar
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


def parse_matches(html, subject_name):
    subj = re.sub(r"\s+", " ", subject_name).strip().upper()
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

        if lname.upper() == subj:
            opp_name, opp_f, my, opp, my_f = rname, rf, lscore, rscore, lf
        elif rname.upper() == subj:
            opp_name, opp_f, my, opp, my_f = lname, lf, rscore, lscore, rf
        else:
            opp_name, opp_f, my, opp, my_f = rname, rf, lscore, rscore, lf

        if subj_fargo is None and my_f is not None:
            subj_fargo = my_f
        matches.append({
            "date": date_label,
            "dateISO": _parse_date(date_label),
            "opponent": opp_name,
            "oppFargo": opp_f,
            "my": my, "opp": opp,
            "result": "W" if my > opp else "L",
        })
    return {"fargo": subj_fargo, "matches": matches}


# ---------------------------------------------------------------------------
# High-level entry points (shared by serve.py and the Vercel functions)
# ---------------------------------------------------------------------------
def fetch_dataset(user, password):
    user = (user or "").strip()
    if not user or not password:
        raise ValueError("Email and password are required.")
    client = Client()
    login(client, user, password)
    dataset = build_dataset(client)
    dataset["cookie"] = client.cookie_header()   # handed to the browser
    return dataset


def fetch_player(cookie, team_id, name):
    if not cookie:
        raise RuntimeError("Session expired — sign in again.")
    tid = int(team_id)
    html = get_with_cookie(f"{BASE}/league/team/{tid}/", cookie)
    result = parse_matches(html, name or "")
    result["team_id"] = tid
    return result
