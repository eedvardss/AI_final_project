/**
 * Minimal CORS proxy for local browser testing with Live Server.
 * Usage: node cors-proxy.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM_HOST = 'http://157.180.73.240';
const LISTEN_PORT = 8787;
const ENV_PATH = path.join(__dirname, '.env');
const EXAM_PORTS = new Set(['22001', '22002', '22003', '22004', '22005']);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(ENV_PATH);
const API_KEY = process.env.API_KEY || '';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const parts = (req.url || '/').split('/').filter(Boolean);
  if (parts.length !== 3) {
    res.statusCode = 400;
    res.end('Expected path: /:port/:x/:y');
    return;
  }

  const [port, x, y] = parts.map(decodeURIComponent);
  const needsApiKey = EXAM_PORTS.has(port);
  if (needsApiKey && !API_KEY) {
    res.statusCode = 500;
    res.end(`Missing API_KEY for exam port ${port}. Put API_KEY=your_real_key in .env`);
    return;
  }

  const upstreamUrl = needsApiKey
    ? `${UPSTREAM_HOST}:${port}/${x}/${y}/${encodeURIComponent(API_KEY)}`
    : `${UPSTREAM_HOST}:${port}/${x}/${y}`;

  try {
    const upstream = await fetch(upstreamUrl);
    const body = await upstream.text();

    res.statusCode = upstream.status;
    const ct = upstream.headers.get('content-type');
    res.setHeader('Content-Type', ct || 'text/plain; charset=utf-8');
    res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.end(`Proxy error: ${error.message}`);
  }
});

server.listen(LISTEN_PORT, () => {
  console.log(`CORS proxy listening on http://localhost:${LISTEN_PORT}`);
  console.log('Forward format: http://localhost:8787/:port/:x/:y');
  console.log(API_KEY ? 'API key loaded for exam ports.' : 'API key not set. Test ports still work.');
});
