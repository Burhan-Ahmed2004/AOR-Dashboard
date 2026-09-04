/**
 * Capture dashboard figures for the technical report.
 *
 * Drives headless Chrome over the DevTools protocol (no dependencies). The
 * dashboard is captured in LIGHT theme because dark screenshots print poorly.
 * This script only READS the dashboard — it changes nothing.
 *
 *   node report/capture-figures.mjs [--port 8795]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'figures');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8795));
const CDP = 9361;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('No Chrome or Edge found. Edit CHROME_CANDIDATES in this script.');
  process.exit(1);
}

/** view id -> [filename, viewport height] */
const FIGURES = [
  ['overview', 'fig-overview.png', 1075],
  ['flow', 'fig-flow.png', 810],
  ['load', 'fig-load.png', 1040],
  ['voltage', 'fig-voltage.png', 1020],
  ['energy', 'fig-energy.png', 1000],
  ['solar', 'fig-solar.png', 930],
  ['breakers', 'fig-switchgear.png', 690],
  ['alarms', 'fig-alarms.png', 660],
  ['forecast', 'fig-forecast.png', 850],
  ['transformers', 'fig-transformers.png', 545],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 1;
function rpc(ws, method, params = {}) {
  const id = msgId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 30000);
    const on = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      clearTimeout(t);
      ws.removeEventListener('message', on);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    };
    ws.addEventListener('message', on);
  });
}

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${path.join(OUT, '.chrome-profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break;
    } catch {}
    await sleep(300);
  }

  const tab = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });

  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 1560, height: 1000, deviceScaleFactor: 1.5, mobile: false,
  });
  await rpc(ws, 'Page.navigate', { url: `http://localhost:${PORT}/` });

  // Let the feed populate so charts and tables have real content.
  await sleep(16000);
  await rpc(ws, 'Runtime.evaluate', { expression: `document.documentElement.dataset.theme='light'` });
  await sleep(1200);

  for (const [view, file, height] of FIGURES) {
    await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 1560, height, deviceScaleFactor: 1.5, mobile: false,
    });
    await rpc(ws, 'Runtime.evaluate', {
      expression: `document.querySelector('#navList button[data-view="${view}"]').click()`,
    });
    await sleep(2600);
    const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
    const kb = Math.round(fs.statSync(path.join(OUT, file)).size / 1024);
    console.log(`  ${file.padEnd(24)} ${kb} KB`);
  }

  ws.close();
  console.log(`\n  ${FIGURES.length} figures written to report/figures/`);
} catch (err) {
  console.error('capture failed:', err.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
}
