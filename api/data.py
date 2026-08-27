"""Vercel serverless function: POST /api/data
Body: {user, password} -> full standings dataset for all active leagues, plus a
`cookie` the browser reuses for /api/player."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pal  # noqa: E402  (sibling helper; underscore = not a route)

from http.server import BaseHTTPRequestHandler  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            n = int(self.headers.get("content-length", 0) or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            data = _pal.fetch_dataset(req.get("user"), req.get("password"))
            self._json(200, data)
        except Exception as e:  # noqa: BLE001 — surface message to the UI
            self._json(400, {"error": str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
