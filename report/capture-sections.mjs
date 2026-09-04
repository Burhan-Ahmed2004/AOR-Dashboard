/**
 * Capture per-SECTION figures for the technical report.
 *
 * Clips each named component out of the live dashboard so every section
 * explained in the report can carry its own screenshot. Read-only: this script
 * navigates and screenshots, it never modifies the dashboard.
 *
 *   node report/capture-sections.mjs [--port 8795]
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
const CDP = 9363;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(1); }

/** [view, css selector, output name] — one row per section explained in the report. */
const SHOTS = [
  // chrome / shared
  ['overview', '.topbar',            'sec-topbar'],
  ['overview', '.provbar',           'sec-provbar'],
  ['overview', '.sidenav',           'sec-sidenav'],
  // overview
  ['overview', '.kpis',              'sec-kpis'],
  ['overview', '#loadChart',         'sec-loadchart'],
  ['overview', '#alarmList',         'sec-alarmlist'],
  ['overview', '#donutDist',         'sec-donut'],
  ['overview', '#catBars',           'sec-catbars'],
  ['overview', '#gaugeEnergy',       'sec-gauge'],
  ['overview', '#energySummary',     'sec-energysummary'],
  ['overview', '#sldFull',           'sec-sld'],
  ['overview', '#voltProfile',       'sec-voltprofile'],
  ['overview', '#bottomMetrics',     'sec-metrics'],
  ['overview', '#gapList',           'sec-gaps'],
  // power flow
  ['flow',     '#flowStats',         'sec-flowstats'],
  ['flow',     '#flowDiagram',       'sec-flowdiagram'],
  ['flow',     '#flowFeeders',       'sec-flowfeeders'],
  // load monitoring
  ['load',     '#groupGrid',         'sec-groupgrid'],
  ['load',     '#pointsSection .filters', 'sec-filters'],
  ['load',     '#pointTable',        'sec-pointtable'],
  // voltage & frequency
  ['voltage',  '#vfStats',           'sec-vfstats'],
  ['voltage',  '#vfFreqChart',       'sec-freqchart'],
  ['voltage',  '#vfCharts',          'sec-vfcharts'],
  ['voltage',  '#vfTable',           'sec-vftable'],
  // energy analytics
  ['energy',   '#eaStats',           'sec-eastats'],
  ['energy',   '#eaMix',             'sec-eamix'],
  ['energy',   '#eaDuration',        'sec-eaduration'],
  ['energy',   '#eaByGroup',         'sec-eabygroup'],
  ['energy',   '#eaTop',             'sec-eatop'],
  // solar
  ['solar',    '#solStats',          'sec-solstats'],
  ['solar',    '#solGauge',          'sec-solgauge'],
  ['solar',    '#solarChart',        'sec-solchart'],
  ['solar',    '#solArrays',         'sec-solarrays'],
  // transformers
  ['transformers', '#txFleet',       'sec-txfleet'],
  ['transformers', '#txBySub',       'sec-txbysub'],
  // switchgear
  ['breakers', '#sgStats',           'sec-sgstats'],
  ['breakers', '#sgBreakers',        'sec-sgbreakers'],
  ['breakers', '#sgDbs',             'sec-sgdbs'],
  // alarms
  ['alarms',   '#alarmList2',        'sec-alarmactive'],
  ['alarms',   '#view-alarms .table-wrap', 'sec-alarmlog'],
  // reports
  ['reports',  '#mgmtSummary',       'sec-mgmtsummary'],
  ['reports',  '#mgmtGroupBars',     'sec-mgmtgroup'],
  ['reports',  '#mgmtSubBars',       'sec-mgmtsub'],
  // forecasting
  ['forecast', '#fcStats',           'sec-fcstats'],
  ['forecast', '#forecastChart',     'sec-fcchart'],
  ['forecast', '#fcTable',           'sec-fctable'],
  // settings
  ['settings', '#footNote',          'sec-provenance'],
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
const chrome = spawn(CHROME, [
  '--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars','--no-first-run',
  '--no-default-browser-check','--disable-extensions',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(OUT, '.chrome-sec')}`, 'about:blank',
], { stdio: 'ignore' });

let ok = 0, missed = [];
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {}
    await sleep(300);
  }
  const tab = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 2, mobile: false });
  await rpc(ws, 'Page.navigate', { url: `http://localhost:${PORT}/` });
  await sleep(17000);
  await rpc(ws, 'Runtime.evaluate', { expression: `document.documentElement.dataset.theme='light'` });
  await sleep(1200);

  let lastView = null;
  for (const [view, sel, name] of SHOTS) {
    if (view !== lastView) {
      await rpc(ws, 'Runtime.evaluate', {
        expression: `document.querySelector('#navList button[data-view="${view}"]').click()`,
      });
      await sleep(2400);
      lastView = view;
    }
    const box = await rpc(ws, 'Runtime.evaluate', {
      returnByValue: true,
      expression: `(()=>{const el=document.querySelector(${JSON.stringify(sel)});
        if(!el) return null; const r=el.getBoundingClientRect();
        if(r.width<8||r.height<8) return null;
        const pad=8;
        return JSON.stringify({x:Math.max(0,r.left-pad),y:Math.max(0,r.top-pad),
          width:Math.min(1500,r.width+pad*2),height:r.height+pad*2});})()`,
    });
    if (!box.result.value) { missed.push(name); continue; }
    const clip = { ...JSON.parse(box.result.value), scale: 2 };
    const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    ok++;
  }
  ws.close();
} catch (err) {
  console.error('capture failed:', err.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
}
console.log(`  ${ok} section figures captured` + (missed.length ? `\n  missed: ${missed.join(', ')}` : ''));
