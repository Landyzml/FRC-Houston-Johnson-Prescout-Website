#!/usr/bin/env python3
"""
Minimal TBA proxy for local use (no deps).

Why:
- Avoid browser CORS issues
- Optionally keep TBA key out of the frontend (use env TBA_KEY)

Usage:
  TBA_KEY=... python3 ./tba-proxy.py
  # or:
  python3 ./tba-proxy.py --port 8787
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse


def _send(handler: BaseHTTPRequestHandler, status: int, body: bytes, content_type: str) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "content-type,x-tba-auth-key")
    handler.send_header("Access-Control-Allow-Methods", "GET,OPTIONS")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:  # noqa: N802
        _send(self, 204, b"", "text/plain; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        try:
            u = urlparse(self.path)
            if u.path == "/health":
                _send(self, 200, json.dumps({"ok": True}).encode("utf-8"), "application/json; charset=utf-8")
                return

            if u.path != "/api/tba":
                _send(self, 404, b"Not found", "text/plain; charset=utf-8")
                return

            qs = parse_qs(u.query)
            path = (qs.get("path", [""])[0] or "").strip()
            if not path.startswith("/"):
                _send(
                    self,
                    400,
                    json.dumps({"error": "Missing or invalid ?path=/..."}).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
                return

            key = self.headers.get("x-tba-auth-key") or os.environ.get("TBA_KEY")
            if not key:
                _send(
                    self,
                    401,
                    json.dumps({"error": "Missing TBA key (header x-tba-auth-key or env TBA_KEY)"}).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
                return

            target = f"https://www.thebluealliance.com/api/v3{path}"
            req = urllib.request.Request(target, headers={"X-TBA-Auth-Key": str(key)})
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = resp.read()
                    content_type = resp.headers.get_content_type() or "application/json"
                    charset = resp.headers.get_content_charset() or "utf-8"
                    ct = f"{content_type}; charset={charset}"
                    _send(self, resp.status, data, ct)
            except urllib.error.HTTPError as e:
                data = e.read() if hasattr(e, "read") else b""
                ct = e.headers.get("content-type") if e.headers else "application/json; charset=utf-8"
                if not data:
                    data = json.dumps({"error": f"TBA HTTP {e.code}"}).encode("utf-8")
                    ct = "application/json; charset=utf-8"
                _send(self, e.code, data, ct)
        except Exception as e:  # noqa: BLE001
            _send(
                self,
                500,
                json.dumps({"error": str(e)}).encode("utf-8"),
                "application/json; charset=utf-8",
            )

    def log_message(self, fmt: str, *args) -> None:  # silence default logging
        return


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", "-p", type=int, default=8787)
    args = ap.parse_args()

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"TBA proxy listening on http://localhost:{args.port}")
    print(f"Try: http://localhost:{args.port}/health")
    server.serve_forever()


if __name__ == "__main__":
    main()

