"""
PAL Data Sorter — the app's single WSGI entrypoint (Model B: open, read-only).

Vercel loads `app` (declared in pyproject.toml [tool.vercel] entrypoint) and
routes every request to it. serve.py runs the same `app` locally via wsgiref.

Routes:
  GET  /api/snapshot   -> the cached dataset the UI renders (standings + detail)
  GET  /api/refresh    -> cron trigger (Vercel sends a GET + Bearer CRON_SECRET)
  POST /api/refresh    -> manual refresh (public; rate-limited to once per hour)
  GET  /*              -> static files (index.html, app.js, styles.css, favicon)

Standard library only.
"""

import json
import os
import urllib.parse

import pal_core

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
}
REASON = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
          429: "Too Many Requests", 500: "Internal Server Error"}


def _send(start_response, code, body, ctype="application/json"):
    data = body if isinstance(body, (bytes, bytearray)) else body.encode("utf-8")
    start_response(f"{code} {REASON.get(code, 'OK')}", [
        ("Content-Type", ctype),
        ("Content-Length", str(len(data))),
        ("Cache-Control", "no-store"),
    ])
    return [data]


def _json(start_response, code, obj):
    return _send(start_response, code, json.dumps(obj))


def _is_cron(environ):
    secret = pal_core.CRON_SECRET
    return bool(secret) and environ.get("HTTP_AUTHORIZATION") == f"Bearer {secret}"


def _refresh(start_response, is_cron):
    try:
        code, body = pal_core.do_refresh(is_cron)
        return _json(start_response, code, body)
    except Exception as e:  # noqa: BLE001 — surface the message to the UI
        return _json(start_response, 500, {"error": str(e)})


def app(environ, start_response):
    method = environ.get("REQUEST_METHOD", "GET")
    path = environ.get("PATH_INFO", "/") or "/"

    if path == "/api/snapshot" and method == "GET":
        snap = pal_core.cache_get_snapshot()
        return _json(start_response, 200,
                     snap or {"fetchedAt": None, "order": [], "leagues": {}, "byId": {}})

    if path == "/api/refresh":
        if method == "POST":
            return _refresh(start_response, _is_cron(environ))
        if method == "GET":
            if not _is_cron(environ):
                return _json(start_response, 403, {"error": "forbidden"})
            return _refresh(start_response, True)
        return _json(start_response, 404, {"error": "not found"})

    # static files
    if method == "GET":
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        ext = os.path.splitext(rel)[1].lower()
        target = os.path.normpath(os.path.join(BASE_DIR, rel))
        if ext in STATIC_TYPES and target.startswith(BASE_DIR) and os.path.isfile(target):
            with open(target, "rb") as f:
                return _send(start_response, 200, f.read(), STATIC_TYPES[ext])

    return _json(start_response, 404, {"error": "not found"})
