/**
 * Minimal CORS proxy for local browser testing with Live Server.
 * Usage: node cors-proxy.js
 */
'use strict';

const http = require('http');

const UPSTREAM_HOST = 'http://157.180.73.240';
const LISTEN_PORT = 8787;

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
  const upstreamUrl = `${UPSTREAM_HOST}:${port}/${x}/${y}`;

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
});
