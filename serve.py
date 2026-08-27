#!/usr/bin/env python3
"""
PAL Data Sorter — local dev server.

Serves the static frontend (index.html, app.js, styles.css) from this folder
and implements the same /api/data and /api/player endpoints the Vercel
deployment exposes, using the shared scraper in api/_pal.py. So what you run
locally behaves exactly like the hosted version.

Standard library only — nothing to install beyond Python itself.

Usage:
    python3 serve.py                 # serve http://127.0.0.1:8765
    python3 serve.py --open          # also open it in your browser
    python3 serve.py --port 9000
"""

import argparse
import json
import os
import socket
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "api"))
import _pal  # noqa: E402

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        ext = os.path.splitext(rel)[1].lower()
        target = os.path.normpath(os.path.join(HERE, rel))
        # only serve known static asset types that live under this folder
        if (ext not in STATIC_TYPES or not target.startswith(HERE)
                or not os.path.isfile(target)):
            self._send(404, json.dumps({"error": "not found"}))
            return
        with open(target, "rb") as f:
            self._send(200, f.read(), STATIC_TYPES[ext])

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
                self._send(200, json.dumps(_pal.fetch_dataset(req.get("user"), req.get("password"))))
            elif path == "/api/player":
                self._send(200, json.dumps(_pal.fetch_player(req.get("cookie"), req.get("team_id"), req.get("name"))))
            else:
                self._send(404, json.dumps({"error": "not found"}))
        except (TypeError, ValueError) as e:
            self._send(400, json.dumps({"error": str(e) or "Invalid request."}))
        except Exception as e:  # noqa: BLE001
            self._send(400, json.dumps({"error": str(e)}))

    def log_message(self, *_):
        pass


def _port_in_use(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) == 0


def main():
    ap = argparse.ArgumentParser(description="PAL Data Sorter local dev server")
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
