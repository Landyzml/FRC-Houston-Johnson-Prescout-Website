#!/usr/bin/env node
/**
 * Minimal TBA proxy for local use.
 *
 * Why:
 * - Avoid browser CORS issues
 * - Optionally keep TBA key out of the frontend (use env TBA_KEY)
 *
 * Usage:
 *   TBA_KEY=... node ./tba-proxy.mjs
 *   # or:
 *   node ./tba-proxy.mjs --port 8787
 */

import http from "node:http";
import { URL } from "node:url";

const args = process.argv.slice(2);
const portArgIndex = args.findIndex((a) => a === "--port" || a === "-p");
const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 8787;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-tba-auth-key",
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-tba-auth-key",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,OPTIONS",
        "access-control-allow-headers": "content-type,x-tba-auth-key",
      });
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname !== "/api/tba") {
      text(res, 404, "Not found");
      return;
    }

    const path = url.searchParams.get("path") || "";
    if (!path.startsWith("/")) {
      json(res, 400, { error: "Missing or invalid ?path=/..." });
      return;
    }

    const key = req.headers["x-tba-auth-key"] || process.env.TBA_KEY;
    if (!key) {
      json(res, 401, { error: "Missing TBA key (provide header x-tba-auth-key or env TBA_KEY)" });
      return;
    }

    const target = `https://www.thebluealliance.com/api/v3${path}`;
    const upstream = await fetch(target, { headers: { "X-TBA-Auth-Key": String(key) } });
    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    const body = await upstream.text();

    res.writeHead(upstream.status, {
      "content-type": contentType,
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,x-tba-auth-key",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`TBA proxy listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`Try: http://localhost:${port}/health`);
});

