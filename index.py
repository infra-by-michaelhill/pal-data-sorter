"""
PAL Data Sorter — single request handler (the app's one entrypoint).

Serves the static frontend on GET and the JSON API on POST
(/api/data, /api/player), using the shared scraper in pal_core.py.

On Vercel this `handler` class is the one entrypoint (declared in vercel.json:
every route is sent here). Locally, serve.py imports this exact same `handler`,
so local and hosted behave identically. Standard library only.
"""

import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler

import pal_core

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


class handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    # ---- static frontend ------------------------------------------------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        ext = os.path.splitext(rel)[1].lower()
        target = os.path.normpath(os.path.join(BASE_DIR, rel))
        # only serve known static asset types that live under this folder
        if (ext not in STATIC_TYPES or not target.startswith(BASE_DIR)
                or not os.path.isfile(target)):
            self._send(404, json.dumps({"error": "not found"}))
            return
        with open(target, "rb") as f:
            self._send(200, f.read(), STATIC_TYPES[ext])

    # ---- JSON API -------------------------------------------------------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._send(400, json.dumps({"error": "Bad request."}))
            return
        try:
            if path == "/api/data":
                self._send(200, json.dumps(pal_core.fetch_dataset(
                    req.get("user"), req.get("password"))))
            elif path == "/api/player":
                self._send(200, json.dumps(pal_core.fetch_player(
                    req.get("cookie"), req.get("team_id"), req.get("name"))))
            else:
                self._send(404, json.dumps({"error": "not found"}))
        except (TypeError, ValueError) as e:
            self._send(400, json.dumps({"error": str(e) or "Invalid request."}))
        except Exception as e:  # noqa: BLE001 — surface message to the UI
            self._send(400, json.dumps({"error": str(e)}))

    def log_message(self, *_):
        pass
