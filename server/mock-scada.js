/**
 * MOCK SCADA SERVER — zero dependencies
 * =====================================
 * Serves the dashboard AND a telemetry feed in the exact shape the dashboard
 * expects, so the real network path (REST + SSE) is exercised end to end rather
 * than faked in the browser.
 *
 * Endpoints
 *   GET /api/points    the point register (tag ids, limits, feeders)
 *   GET /api/readings  latest sample for every reporting point  [polling clients]
 *   GET /api/stream    server-sent events, one frame per tick   [push clients]
 *   GET /api/health    tick count, uptime, connected stream clients
 *
 * Payload shape — this is the contract to implement against your real SCADA:
 *   { "ts": 1754200000000,
 *     "daylight": true,
 *     "readings": [ { "id": "TW-01", "kW": 14.8, "ts": 1754200000000, "quality": "good" } ] }
 *
 * A point whose meter is unreachable is ABSENT from `readings`. It is never sent
 * as 0 kW — the dashboard distinguishes "offline" from "drawing nothing", and
 * sending zeros would destroy that distinction.
 *
 * Run:  node server/mock-scada.js  [--port 8787] [--interval 2000]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONITORED_POINTS, GROUPS, POINTS, SUBSTATIONS, SITE, DATA_GAPS } from '../src/register.js';
import { createSimulator } from '../src/simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg('port', process.env.PORT || 8787));
const INTERVAL = Number(arg('interval', 2000));

const sim = createSimulator(MONITORED_POINTS, GROUPS);
let latest = sim.sample(Date.now());
let ticks = 0;
const startedAt = Date.now();

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

setInterval(() => {
  latest = sim.sample(Date.now());
  ticks += 1;
  const frame = `data: ${JSON.stringify(latest)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}, INTERVAL);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(s);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  // Never serve outside the project root.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/readings') return sendJson(res, latest);

  if (p === '/api/points') {
    return sendJson(res, {
      site: SITE,
      groups: GROUPS,
      substations: SUBSTATIONS.map(({ ...s }) => s),
      dataGaps: DATA_GAPS,
      points: POINTS.map((pt) => ({
        id: pt.id,
        name: pt.name,
        location: pt.location,
        zone: pt.zone,
        groupId: pt.groupId,
        substationId: pt.substationId,
        role: pt.role,
        service: pt.service,
        monitored: pt.monitored,
        units: pt.units,
        unitKw: pt.unitKw,
        ratedKw: pt.ratedKw,
        warnKw: pt.warnKw,
        alarmKw: pt.alarmKw,
        lowWarnKw: pt.lowWarnKw,
        lowAlarmKw: pt.lowAlarmKw,
      })),
    });
  }

  if (p === '/api/health') {
    return sendJson(res, {
      ok: true,
      ticks,
      uptimeMs: Date.now() - startedAt,
      intervalMs: INTERVAL,
      streamClients: clients.size,
      pointsMonitored: MONITORED_POINTS.length,
      reportingLastTick: latest.readings.length,
    });
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(latest)}\n\n`); // prime immediately
    clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* handled on close */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  return serveStatic(req, res, p);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
  Port ${PORT} is already in use.
`);
    console.error(`  Easiest fix - run on a different port:
`);
    console.error(`      node server/mock-scada.js --port ${PORT + 1}
`);
    console.error(`  Or free this one. Step 1, find the PID (the LAST column of the output):`);
    console.error(
      process.platform === 'win32'
        ? `      netstat -ano | findstr :${PORT}
`
        : `      lsof -ti :${PORT}
`
    );
    console.error(`  Step 2, kill it using that number. For example if the PID were 1234:`);
    console.error(
      process.platform === 'win32'
        ? `      taskkill /F /PID 1234        <-- substitute the real PID
`
        : `      kill -9 1234                 <-- substitute the real PID
`
    );
    if (process.platform === 'win32') {
      console.error(`  Or do both steps at once in PowerShell:`);
      console.error(
        `      Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force
`
      );
    }
    process.exit(1);
  }
  console.error(`\n  Server error: ${err.message}\n`);
  process.exit(1);
});

// Ctrl-C should drop the open SSE connections cleanly rather than leaving
// clients hanging on a half-open stream.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

server.listen(PORT, () => {
  const n = MONITORED_POINTS.length;
  console.log(`
  Power Load Monitor — mock SCADA server
  -------------------------------------
  Dashboard   http://localhost:${PORT}/
  Readings    http://localhost:${PORT}/api/readings
  Stream      http://localhost:${PORT}/api/stream   (SSE)
  Register    http://localhost:${PORT}/api/points
  Health      http://localhost:${PORT}/api/health

  ${n} monitored points · ${POINTS.length - n} in the register but not instrumented
  Emitting one frame every ${INTERVAL} ms.  Ctrl-C to stop.
`);
});
