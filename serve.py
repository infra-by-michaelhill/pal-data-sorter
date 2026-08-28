#!/usr/bin/env python3
"""
PAL Data Sorter — local dev server.

Runs the same WSGI `app` that Vercel runs (index.py), via the standard library's
wsgiref server (threaded, so a long refresh doesn't block page loads). So local
behaves like production. Standard library only.

Set PAL_USER / PAL_PASS in the environment so the refresh can scrape:
    PAL_USER=you@example.com PAL_PASS=secret python3 serve.py --open

Usage:
    python3 serve.py                 # serve http://127.0.0.1:8765
    python3 serve.py --open          # also open it in your browser
    python3 serve.py --port 9000
"""

import argparse
import socket
import socketserver
import threading
import webbrowser
from wsgiref.simple_server import WSGIServer, WSGIRequestHandler, make_server

from index import app


class _ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    daemon_threads = True


class _QuietHandler(WSGIRequestHandler):
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

    server = make_server(args.host, args.port, app,
                         server_class=_ThreadingWSGIServer, handler_class=_QuietHandler)
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
