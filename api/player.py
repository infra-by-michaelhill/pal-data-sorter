"""Vercel serverless function: POST /api/player
Body: {cookie, team_id, name} -> that team's match history (date, opponent,
opponent Fargo, score, W/L). Stateless — the cookie comes from /api/data."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pal  # noqa: E402

from http.server import BaseHTTPRequestHandler  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            n = int(self.headers.get("content-length", 0) or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            result = _pal.fetch_player(req.get("cookie"), req.get("team_id"), req.get("name"))
            self._json(200, result)
        except (TypeError, ValueError):
            self._json(400, {"error": "Invalid player id."})
        except Exception as e:  # noqa: BLE001
            self._json(400, {"error": str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
