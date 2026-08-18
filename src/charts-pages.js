/**
 * PAGE-SPECIFIC CHARTS
 * ====================
 * Forms used by the detail pages: the power-flow diagram, device status grids,
 * a forecast band chart and a load-duration curve.
 */

import { kw, clockTime, escapeHtml, pct } from './format.js';
import { el, niceTicks } from './charts.js';

// ---------------------------------------------------------------------------
// Power flow — grid -> bus -> substations -> load groups.
// Link thickness is proportional to power, so the diagram reads as a flow
// rather than a wiring schematic. Every link carries its value as a label.
// ---------------------------------------------------------------------------

export function renderPowerFlow(container, { sources, substations, groups, lossKw }) {
  const W = 920;
  const rowH = 30;
  const H = Math.max(360, 90 + Math.max(substations.length, groups.length) * rowH + 40);
  const colX = [70, 300, 560, 830];

  const totalIn = sources.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
  const maxLink = Math.max(totalIn, 1);
  const thick = (v) => Math.max(1.5, (Math.abs(v) / maxLink) * 34);

  const p = [];
  p.push(`<defs><linearGradient id="pfg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="var(--cat-1)" stop-opacity=".55"/>
      <stop offset="100%" stop-color="var(--cat-1)" stop-opacity=".18"/>
    </linearGradient></defs>`);

  // column headings
  const heads = ['SOURCE', 'MAIN 11 kV BUS', 'SUBSTATION', 'LOAD GROUP'];
  heads.forEach((h, i) => {
    p.push(`<text x="${colX[i]}" y="22" class="pf-head" text-anchor="${i === 3 ? 'end' : 'middle'}">${h}</text>`);
  });

  // --- sources -> bus -------------------------------------------------------
  const busX = colX[1];
  const busTop = 56;
  const busBot = H - 44;
  const busMid = (busTop + busBot) / 2;
  let sy = busTop + 24;
  sources.forEach((s, i) => {
    const y = sy + i * 46;
    p.push(`<path class="pf-link" d="M ${colX[0] + 46} ${y} C ${(colX[0] + busX) / 2} ${y}, ${(colX[0] + busX) / 2} ${busMid}, ${busX} ${busMid}"
      stroke-width="${thick(s.value)}"/>`);
    p.push(`<g><rect class="pf-node pf-node--src" x="${colX[0] - 46}" y="${y - 17}" width="92" height="34" rx="7"/>
      <text class="pf-name" x="${colX[0]}" y="${y - 2}" text-anchor="middle">${escapeHtml(s.label)}</text>
      <text class="pf-val" x="${colX[0]}" y="${y + 11}" text-anchor="middle">${kw(s.value)}</text></g>`);
  });

  // --- the bus bar ----------------------------------------------------------
  p.push(`<line class="pf-bus" x1="${busX}" y1="${busTop}" x2="${busX}" y2="${busBot}"/>`);
  p.push(`<text class="pf-val" x="${busX + 10}" y="${busTop - 6}">${kw(totalIn)} in</text>`);

  // --- bus -> substations ---------------------------------------------------
  const subX = colX[2];
  const subSpan = busBot - busTop - 30;
  substations.forEach((s, i) => {
    const y = busTop + 22 + (substations.length === 1 ? subSpan / 2 : (i / (substations.length - 1)) * subSpan);
    p.push(`<path class="pf-link" d="M ${busX} ${busMid} C ${(busX + subX) / 2} ${busMid}, ${(busX + subX) / 2} ${y}, ${subX - 60} ${y}"
      stroke-width="${thick(s.value)}"/>`);
    p.push(`<g class="pf-node-g pf-node-g--${s.severity || 'normal'}">
      <rect class="pf-node" x="${subX - 60}" y="${y - 18}" width="120" height="36" rx="7"/>
      <text class="pf-name" x="${subX}" y="${y - 3}" text-anchor="middle">${escapeHtml(s.label)}</text>
      <text class="pf-val" x="${subX}" y="${y + 11}" text-anchor="middle">${kw(s.value)} · ${pct(s.loadingPct, 0)}</text></g>`);
    // substation -> its groups
    for (const g of s.groups || []) {
      const gy = g.y;
      p.push(`<path class="pf-link pf-link--load" d="M ${subX + 60} ${y} C ${(subX + colX[3]) / 2} ${y}, ${(subX + colX[3]) / 2} ${gy}, ${colX[3] - 168} ${gy}"
        stroke-width="${thick(g.value)}"/>`);
    }
  });

  // --- load groups ----------------------------------------------------------
  groups.forEach((g) => {
    p.push(`<g><rect class="pf-node pf-node--load" x="${colX[3] - 168}" y="${g.y - 13}" width="168" height="26" rx="6"/>
      <text class="pf-name pf-name--sm" x="${colX[3] - 160}" y="${g.y + 4}">${escapeHtml(g.label)}</text>
      <text class="pf-val" x="${colX[3] - 8}" y="${g.y + 4}" text-anchor="end">${kw(g.value)}</text></g>`);
  });

  if (lossKw > 0) {
    p.push(`<text class="pf-loss" x="${busX + 10}" y="${busBot + 16}">Distribution losses ${kw(lossKw)}</text>`);
  }

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="pf-svg" role="img" aria-label="Power flow from source to load groups">${p.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Status grid — one cell per device. Status is icon + word + colour.
// ---------------------------------------------------------------------------

export function renderStatusGrid(container, items) {
  container.innerHTML = items
    .map(
      (it) => `<div class="sgcell sgcell--${it.tone}">
        <div class="sgcell-top"><span class="sgcell-id">${escapeHtml(it.id)}</span>
          <span class="sgcell-state">${it.icon || ''}${escapeHtml(it.state)}</span></div>
        <div class="sgcell-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
        <div class="sgcell-meta">${escapeHtml(it.meta || '')}</div>
      </div>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Band chart — a forecast line inside a confidence band.
// The band is drawn as a wash so it never reads as a second data series.
// ---------------------------------------------------------------------------

export function createBandChart(container, options = {}) {
  const opts = {
    height: 230, padTop: 14, padRight: 62, padBottom: 26, padLeft: 54,
    unit: 'kW', label: 'Forecast', ...options,
  };
  container.classList.add('chart');
  const svg = el('svg', { class: 'chart-svg', role: 'img' });
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(svg, tip);

  const gGrid = el('g', {});
  const band = el('path', { class: 'band-fill' });
  const actual = el('path', { class: 'line-mark', fill: 'none' });
  const fcast = el('path', { class: 'line-mark line-mark--forecast', fill: 'none' });
  const gRefs = el('g', {});
  const gAxis = el('g', {});
  const nowLine = el('line', { class: 'now-line' });
  const hit = el('rect', { class: 'chart-hit', fill: 'transparent' });
  svg.append(gGrid, band, gRefs, actual, fcast, nowLine, gAxis, hit);

  const state = { pts: [], refs: [], nowIdx: -1, w: 0 };
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  function scales() {
    const innerW = Math.max(10, state.w - opts.padLeft - opts.padRight);
    const innerH = Math.max(10, opts.height - opts.padTop - opts.padBottom);
    let lo = Infinity, hi = -Infinity;
    for (const p of state.pts) {
      for (const v of [p.v, p.lo, p.hi]) {
        if (v == null) continue;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
    }
    for (const r of state.refs) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.14;
    lo -= pad; hi += pad;
    const n = Math.max(1, state.pts.length - 1);
    return {
      x: (i) => opts.padLeft + (i / n) * innerW,
      y: (v) => opts.padTop + innerH - ((v - lo) / (hi - lo)) * innerH,
      lo, hi, innerW, innerH,
    };
  }

  function draw() {
    state.w = Math.max(160, Math.round(container.getBoundingClientRect().width));
    svg.setAttribute('viewBox', `0 0 ${state.w} ${opts.height}`);
    svg.setAttribute('height', opts.height);
    hit.setAttribute('width', state.w);
    hit.setAttribute('height', opts.height);
    if (state.pts.length < 2) return;
    const { x, y, lo, hi, innerW, innerH } = scales();

    gGrid.replaceChildren();
    gAxis.replaceChildren();
    for (const t of niceTicks(lo, hi, 4)) {
      const yy = y(t);
      if (yy < opts.padTop - 2 || yy > opts.padTop + innerH + 2) continue;
      gGrid.append(el('line', { x1: opts.padLeft, x2: opts.padLeft + innerW, y1: yy, y2: yy, class: 'gridline' }));
      const lb = el('text', { x: opts.padLeft - 8, y: yy + 3.5, class: 'axis-label', 'text-anchor': 'end' });
      lb.textContent = Math.round(t).toLocaleString('en-US');
      gAxis.append(lb);
    }
    const step = Math.max(1, Math.floor(state.pts.length / 6));
    for (let i = 0; i < state.pts.length; i += step) {
      const t = el('text', { x: x(i), y: opts.height - 8, class: 'axis-label', 'text-anchor': 'middle' });
      t.textContent = state.pts[i].label;
      gAxis.append(t);
    }

    const withBand = state.pts.filter((p) => p.lo != null);
    if (withBand.length > 1) {
      const up = withBand.map((p) => `${x(state.pts.indexOf(p)).toFixed(1)},${y(p.hi).toFixed(1)}`);
      const dn = withBand.slice().reverse().map((p) => `${x(state.pts.indexOf(p)).toFixed(1)},${y(p.lo).toFixed(1)}`);
      band.setAttribute('d', `M${up.join('L')}L${dn.join('L')}Z`);
      band.style.display = '';
    } else band.style.display = 'none';

    const line = (filter) => {
      const seg = [];
      state.pts.forEach((p, i) => {
        if (!filter(p, i) || p.v == null) { seg.push(null); return; }
        seg.push(`${x(i).toFixed(1)},${y(p.v).toFixed(1)}`);
      });
      let d = '', pen = false;
      for (const s of seg) {
        if (s == null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + s;
        pen = true;
      }
      return d;
    };
    actual.setAttribute('d', line((p, i) => state.nowIdx < 0 || i <= state.nowIdx));
    fcast.setAttribute('d', line((p, i) => state.nowIdx < 0 || i >= state.nowIdx));

    gRefs.replaceChildren();
    for (const r of state.refs) {
      const yy = y(r.value);
      if (yy < opts.padTop - 2 || yy > opts.padTop + innerH + 2) continue;
      gRefs.append(el('line', { x1: opts.padLeft, x2: opts.padLeft + innerW, y1: yy, y2: yy, class: `ref-line ref-${r.kind}` }));
      const t = el('text', { x: opts.padLeft + innerW + 5, y: yy + 3.5, class: 'ref-label' });
      t.textContent = r.label;
      gRefs.append(t);
    }

    if (state.nowIdx >= 0) {
      nowLine.setAttribute('x1', x(state.nowIdx));
      nowLine.setAttribute('x2', x(state.nowIdx));
      nowLine.setAttribute('y1', opts.padTop);
      nowLine.setAttribute('y2', opts.padTop + innerH);
      nowLine.style.display = '';
    } else nowLine.style.display = 'none';
  }

  hit.addEventListener('pointermove', (e) => {
    if (state.pts.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const { x, innerW } = scales();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - opts.padLeft) / Math.max(1, innerW)));
    const i = Math.round(frac * (state.pts.length - 1));
    const p = state.pts[i];
    tip.innerHTML =
      `<div class="tip-time">${escapeHtml(p.label)}${i > state.nowIdx && state.nowIdx >= 0 ? ' · forecast' : ''}</div>` +
      `<div class="tip-row"><span class="tip-key">${escapeHtml(opts.label)}</span><span class="tip-val">${kw(p.v)}</span></div>` +
      (p.lo != null
        ? `<div class="tip-row"><span class="tip-key">Range</span><span class="tip-val">${kw(p.lo)} – ${kw(p.hi)}</span></div>`
        : '');
    tip.hidden = false;
    const tw = tip.offsetWidth || 170;
    tip.style.left = `${Math.max(4, Math.min(container.clientWidth - tw - 4, x(i) + 12))}px`;
    tip.style.top = '6px';
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; });

  return {
    update(pts, refs = [], nowIdx = -1) {
      state.pts = pts; state.refs = refs; state.nowIdx = nowIdx;
      draw();
    },
    destroy() { ro.disconnect(); },
  };
}

// ---------------------------------------------------------------------------
// Load-duration curve — demand sorted high to low. Shows how much of the
// period sits near peak, which a time-series trend cannot.
// ---------------------------------------------------------------------------

export function renderDurationCurve(container, values, { height = 180, refs = [] } = {}) {
  const w = Math.max(160, Math.round(container.getBoundingClientRect().width) || 320);
  const padL = 50, padR = 16, padT = 10, padB = 24;
  const sorted = values.slice().sort((a, b) => b - a);
  if (sorted.length < 2) { container.innerHTML = ''; return; }
  const innerW = w - padL - padR, innerH = height - padT - padB;
  let lo = Math.min(...sorted), hi = Math.max(...sorted);
  for (const r of refs) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  const x = (i) => padL + (i / (sorted.length - 1)) * innerW;
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo)) * innerH;

  const line = sorted.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(sorted.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)}L${padL},${(padT + innerH).toFixed(1)}Z`;

  const ticks = niceTicks(lo, hi, 4)
    .filter((t) => y(t) >= padT - 2 && y(t) <= padT + innerH + 2)
    .map(
      (t) =>
        `<line class="gridline" x1="${padL}" x2="${padL + innerW}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="axis-label" x="${padL - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(t).toLocaleString('en-US')}</text>`
    )
    .join('');

  const refLines = refs
    .map(
      (r) =>
        `<line class="ref-line ref-${r.kind}" x1="${padL}" x2="${padL + innerW}" y1="${y(r.value).toFixed(1)}" y2="${y(r.value).toFixed(1)}"/>`
    )
    .join('');

  container.innerHTML = `<svg viewBox="0 0 ${w} ${height}" class="chart-svg" role="img" aria-label="Load duration curve">
    ${ticks}${refLines}
    <path class="ldc-area" d="${area}"/>
    <path class="line-mark" fill="none" d="${line}"/>
    <text class="axis-label" x="${padL}" y="${height - 7}">0% of period</text>
    <text class="axis-label" x="${padL + innerW}" y="${height - 7}" text-anchor="end">100%</text>
  </svg>`;
}
