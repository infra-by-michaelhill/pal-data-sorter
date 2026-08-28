#!/usr/bin/env python3
"""
PAL Data Sorter — local dev server.

Reuses the exact same request handler that Vercel runs (index.py), so what you
see locally matches the hosted version. Standard library only — nothing to
install beyond Python itself.

Usage:
    python3 serve.py                 # serve http://127.0.0.1:8765
    python3 serve.py --open          # also open it in your browser
    python3 serve.py --port 9000
"""

import argparse
import socket
import threading
import webbrowser
from http.server import ThreadingHTTPServer

from index import handler  # the same handler Vercel uses


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

    server = ThreadingHTTPServer((args.host, args.port), handler)
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
