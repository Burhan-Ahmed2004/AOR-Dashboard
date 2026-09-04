/**
 * Assemble the report parts and render the PDF.
 *
 *  1. Concatenates report/part-*.html into report/report.html
 *  2. Loads it in headless Chrome at the printable page width
 *  3. Measures each chapter and computes its start page, then injects those
 *     page numbers into the table of contents
 *  4. Prints to PDF with a running header and footer
 *  5. Verifies the predicted page count against the actual PDF page count
 *
 *   node report/build-pdf.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PREFIX = arg('prefix', 'part-');
const OUT_PDF = path.join(ROOT, arg('out', 'Power_Monitor_Technical_Analysis_Report.pdf'));
const SRC_NAME = arg('src', 'report.html');
// Page the FIRST chapter lands on. The English report puts the cover and the
// contents on their own pages, so chapters start at 3; the Roman Urdu edition
// merges the contents onto the cover, so they start at 2.
const START_PAGE = Number(arg('start', 3));
const TITLE = arg('title', 'Power Monitor — Technical Analysis & Explanation Report');
const CDP = 9371;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(1); }

// --- 1. assemble ----------------------------------------------------------
const partRe = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d+.*\\.html$');
const parts = fs.readdirSync(__dirname).filter((f) => partRe.test(f)).sort();
if (!parts.length) { console.error(`No ${PREFIX}*.html files found`); process.exit(1); }
const html = parts.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const SRC = path.join(__dirname, SRC_NAME);
fs.writeFileSync(SRC, html);
console.log(`  assembled ${parts.length} parts -> report/${SRC_NAME} (${Math.round(html.length / 1024)} KB)`);

// A4 printable area at 96 dpi, given the 20/18/18/18 mm margins in @page.
const MM = 96 / 25.4;
const PAGE_W = Math.round((210 - Number(arg('mx', 18)) * 2) * MM);
const PAGE_H = Math.round((297 - Number(arg('mt', 20)) - Number(arg('mb', 18))) * MM);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 1;
function rpc(ws, method, params = {}) {
  const id = msgId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 120000);
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

const chrome = spawn(CHROME, [
  '--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars','--no-first-run',
  '--no-default-browser-check','--disable-extensions','--font-render-hinting=none',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(__dirname, '.chrome-pdf')}`, 'about:blank',
], { stdio: 'ignore' });

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
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: PAGE_W, height: PAGE_H, deviceScaleFactor: 1, mobile: false });
  await rpc(ws, 'Page.navigate', { url: 'file:///' + SRC.replace(/\\/g, '/') });
  await sleep(2500);
  // Wait for webfonts and images so measurement reflects final layout.
  await rpc(ws, 'Runtime.evaluate', { awaitPromise: true, expression: `Promise.all([document.fonts.ready, ...[...document.images].map(i=>i.complete?0:new Promise(r=>{i.onload=i.onerror=r;}))])` });
  await sleep(1200);

  // --- 3. measure chapters EXACTLY, then build the TOC ---------------------
  // Estimating pagination from element heights is unreliable: elements marked
  // break-inside:avoid get pushed whole to the next page, and the resulting
  // whitespace cannot be predicted from height alone. So each chapter is
  // printed ALONE and its real page count read back from the PDF. Because
  // every chapter starts on a fresh page, chapters do not interact, and the
  // sum of the isolated counts is exact.
  const PRINT_OPTS = {
    printBackground: true,
    paperWidth: 8.27, paperHeight: 11.69,
    marginTop: Number(arg('mt', 20)) / 25.4, marginBottom: Number(arg('mb', 18)) / 25.4,
    marginLeft: Number(arg('mx', 18)) / 25.4, marginRight: Number(arg('mx', 18)) / 25.4,
  };
  const pageCount = (b64) => {
    const t = Buffer.from(b64, 'base64').toString('latin1');
    const counts = [...t.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    return counts.length ? Math.max(...counts) : (t.match(/\/Type\s*\/Page[^s]/g) || []).length;
  };

  const info = JSON.parse((await rpc(ws, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify([...document.querySelectorAll('.chapter')]
      .map((c, i) => ({ i, n: c.dataset.num, title: c.dataset.title })))`,
  })).result.value);

  const measured = [];
  for (const ch of info) {
    await rpc(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const cv = document.querySelector('.cover'); if (cv) cv.style.display = 'none';
        const tc = document.querySelector('.toc');   if (tc) tc.style.display = 'none';
        // Isolate by INDEX, not id: chapters are not required to carry ids,
        // and an empty id would match every chapter and hide none of them.
        document.querySelectorAll('.chapter').forEach((c, i) => {
          c.style.display = (i === ${ch.i}) ? '' : 'none';
        });
      })()`,
    });
    const one = await rpc(ws, 'Page.printToPDF', PRINT_OPTS);
    measured.push({ ...ch, pages: pageCount(one.data) });
  }

  await rpc(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const cv = document.querySelector('.cover'); if (cv) cv.style.display = '';
      const tc = document.querySelector('.toc');   if (tc) tc.style.display = '';
      for (const c of document.querySelectorAll('.chapter')) c.style.display = '';
    })()`,
  });

  let page = START_PAGE;
  const rows = measured.map((m) => { const r = { ...m, page }; page += m.pages; return r; });
  const predictedTotal = page - 1;

  await rpc(ws, 'Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('tocList').innerHTML = ${JSON.stringify(
        rows.map((r) =>
          `<div class="toc-row"><span class="toc-n">${r.n}</span><span>${r.title}</span><span class="toc-p">${r.page}</span></div>`
        ).join('')
      )};
      document.getElementById('reportDate').textContent =
        new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
    })()`,
  });
  const meta = { predictedTotal, chapters: rows.length };
  await sleep(800);
  console.log(`  ${meta.chapters} chapters measured individually, total ${meta.predictedTotal} pages`);

  // --- 4. print -----------------------------------------------------------
  const headerTemplate = `<div style="font-family:'Source Sans 3',Segoe UI,sans-serif;font-size:7pt;color:#8b939b;
    width:100%;padding:0 18mm;display:flex;justify-content:space-between;border-bottom:.5pt solid #dfe3e7;
    padding-bottom:2mm;">
    <span>${TITLE}</span>
    <span>AOR / GE(N) Maint Isld</span></div>`;
  const footerTemplate = `<div style="font-family:'Source Sans 3',Segoe UI,sans-serif;font-size:7pt;color:#8b939b;
    width:100%;padding:0 18mm;display:flex;justify-content:space-between;border-top:.5pt solid #dfe3e7;
    padding-top:2mm;">
    <span>Issued for review</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

  const pdf = await rpc(ws, 'Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.27, paperHeight: 11.69,
    marginTop: Number(arg('mt', 20)) / 25.4, marginBottom: Number(arg('mb', 18)) / 25.4,
    marginLeft: Number(arg('mx', 18)) / 25.4, marginRight: Number(arg('mx', 18)) / 25.4,
    displayHeaderFooter: true,
    headerTemplate, footerTemplate,
    preferCSSPageSize: false,
  });
  const buf = Buffer.from(pdf.data, 'base64');
  fs.writeFileSync(OUT_PDF, buf);
  ws.close();

  // --- 5. verify ----------------------------------------------------------
  const text = buf.toString('latin1');
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const actual = counts.length ? Math.max(...counts) : (text.match(/\/Type\s*\/Page[^s]/g) || []).length;

  console.log(`\n  PDF written: ${OUT_PDF}`);
  console.log(`  Size: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Pages: actual ${actual}, predicted ${meta.predictedTotal}`);
  if (actual === meta.predictedTotal) {
    console.log('  TOC page numbers: VERIFIED (prediction matches actual)');
  } else {
    console.log(`  TOC page numbers: APPROXIMATE (off by ${actual - meta.predictedTotal})`);
  }
} catch (err) {
  console.error('build failed:', err.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
}
