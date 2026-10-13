/**
 * CHARTS — hand-rolled SVG, no chart library
 * ==========================================
 * Colours come from CSS custom properties (see index.html) so light and dark are
 * each their own selected set of steps rather than an automatic inversion.
 *
 * Conventions held throughout:
 *  · data marks are SOLID (2px lines, ~10% area wash)
 *  · reference rules — limits and typical load — are DASHED hairlines, because
 *    here a dashed line genuinely means "threshold", and they carry direct labels
 *  · gridlines are solid hairlines, one step off the surface, recessive
 *  · every chart has a crosshair + tooltip, reachable by keyboard as well as
 *    pointer, and every value it shows is also in the table view
 */

import { kw, clockTime, escapeHtml } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

export function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
}

function cssVar(node, name, fallback) {
  const v = getComputedStyle(node).getPropertyValue(name).trim();
  return v || fallback;
}

/** Nice round axis ticks (0 / 1,000 / 2,000 …). */
export function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

// ---------------------------------------------------------------------------
// Trend chart — area + line, reference rules, crosshair tooltip, keyboard nav
// ---------------------------------------------------------------------------

export function createTrendChart(container, options = {}) {
  const opts = {
    height: 200,
    padTop: 14,
    padRight: 64, // room for the reference-rule labels
    padBottom: 26,
    padLeft: 52,
    showExpected: true,
    label: 'Net load',
    ...options,
  };

  container.classList.add('chart');
  const svg = el('svg', { class: 'chart-svg', role: 'img' });
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tip';
  tooltip.hidden = true;
  container.append(svg, tooltip);

  const gGrid = el('g', { class: 'grid' });
  const gRefs = el('g', { class: 'refs' });
  const linePath = el('path', { class: 'line-mark', fill: 'none' });
  const expPath = el('path', { class: 'ref-line ref-typical', fill: 'none' });
  const gAxis = el('g', { class: 'axis' });
  const crossLine = el('line', { class: 'crosshair', y1: 0, y2: 0, x1: 0, x2: 0 });
  const crossDot = el('circle', { class: 'crosshair-dot', r: 4.5 });
  const endDot = el('circle', { class: 'end-dot', r: 4.5 });
  const hit = el('rect', { class: 'chart-hit', fill: 'transparent' });
  svg.append(gGrid, expPath, linePath, gRefs, gAxis, crossLine, crossDot, endDot, hit);

  let state = { series: [], refs: [], w: 0, h: opts.height, focus: -1 };

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  function scales() {
    const { w, h } = state;
    const innerW = Math.max(10, w - opts.padLeft - opts.padRight);
    const innerH = Math.max(10, h - opts.padTop - opts.padBottom);
    const series = state.series;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of series) {
      lo = Math.min(lo, p.v, opts.showExpected && p.e != null ? p.e : p.v);
      hi = Math.max(hi, p.v, opts.showExpected && p.e != null ? p.e : p.v);
    }
    for (const r of state.refs) {
      lo = Math.min(lo, r.value);
      hi = Math.max(hi, r.value);
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi === lo) hi = lo + Math.max(1, Math.abs(lo) * 0.1);
    // Zoom to the data range rather than forcing a zero baseline: on a feeder
    // trend the whole story is the variation, and anchoring at 0 flattens a
    // 200 kW swing on a 5,000 kW base into an unreadable straight line. This is
    // safe here because the mark is a LINE, not a filled area — a filled area
    // off a non-zero baseline would overstate the magnitude. The y-axis is
    // always labelled so the offset baseline is explicit.
    const pad = (hi - lo) * 0.15;
    lo = lo - pad;
    hi = hi + pad;
    const x = (i) => opts.padLeft + (series.length <= 1 ? innerW : (i / (series.length - 1)) * innerW);
    const y = (v) => opts.padTop + innerH - ((v - lo) / (hi - lo)) * innerH;
    return { x, y, lo, hi, innerW, innerH };
  }

  function draw() {
    const rect = container.getBoundingClientRect();
    state.w = Math.max(120, Math.round(rect.width));
    state.h = opts.height;
    svg.setAttribute('viewBox', `0 0 ${state.w} ${state.h}`);
    svg.setAttribute('width', state.w);
    svg.setAttribute('height', state.h);
    hit.setAttribute('x', 0);
    hit.setAttribute('y', 0);
    hit.setAttribute('width', state.w);
    hit.setAttribute('height', state.h);

    const series = state.series;
    if (!series.length) return;
    const { x, y, lo, hi, innerW, innerH } = scales();

    // --- gridlines + y ticks (solid hairlines, recessive) -------------------
    gGrid.replaceChildren();
    gAxis.replaceChildren();
    for (const t of niceTicks(lo, hi, 4)) {
      const yy = y(t);
      if (yy < opts.padTop - 2 || yy > opts.padTop + innerH + 2) continue;
      gGrid.append(el('line', { x1: opts.padLeft, x2: opts.padLeft + innerW, y1: yy, y2: yy, class: 'gridline' }));
      const lbl = el('text', { x: opts.padLeft - 8, y: yy + 3.5, class: 'axis-label', 'text-anchor': 'end' });
      lbl.textContent = t.toLocaleString('en-US');
      gAxis.append(lbl);
    }
    // x-axis: first / middle / last timestamps only
    for (const i of [0, Math.floor((series.length - 1) / 2), series.length - 1]) {
      if (i < 0 || !series[i]) continue;
      const t = el('text', {
        x: x(i),
        y: state.h - 8,
        class: 'axis-label',
        'text-anchor': i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle',
      });
      t.textContent = clockTime(series[i].t);
      gAxis.append(t);
    }

    // --- data marks ---------------------------------------------------------
    const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    linePath.setAttribute('d', line);
    if (opts.showExpected && series.some((p) => p.e != null)) {
      expPath.setAttribute(
        'd',
        series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.e ?? p.v).toFixed(1)}`).join('')
      );
      expPath.style.display = '';
    } else {
      expPath.style.display = 'none';
    }
    const last = series[series.length - 1];
    endDot.setAttribute('cx', x(series.length - 1));
    endDot.setAttribute('cy', y(last.v));

    // --- reference rules with direct labels ---------------------------------
    gRefs.replaceChildren();
    for (const r of state.refs) {
      const yy = y(r.value);
      if (yy < opts.padTop - 2 || yy > opts.padTop + innerH + 2) continue;
      gRefs.append(
        el('line', {
          x1: opts.padLeft,
          x2: opts.padLeft + innerW,
          y1: yy,
          y2: yy,
          class: `ref-line ref-${r.kind}`,
        })
      );
      const t = el('text', { x: opts.padLeft + innerW + 6, y: yy + 3.5, class: 'ref-label' });
      t.textContent = r.label;
      gRefs.append(t);
    }

    setFocus(state.focus, false);
  }

  function setFocus(i, showTip = true) {
    const series = state.series;
    if (!series.length || i < 0 || i >= series.length) {
      crossLine.style.display = 'none';
      crossDot.style.display = 'none';
      tooltip.hidden = true;
      return;
    }
    const { x, y, innerH } = scales();
    const p = series[i];
    crossLine.style.display = '';
    crossDot.style.display = '';
    crossLine.setAttribute('x1', x(i));
    crossLine.setAttribute('x2', x(i));
    crossLine.setAttribute('y1', opts.padTop);
    crossLine.setAttribute('y2', opts.padTop + innerH);
    crossDot.setAttribute('cx', x(i));
    crossDot.setAttribute('cy', y(p.v));
    if (!showTip) return;
    const rows = [
      `<span class="tip-key"><i class="tip-swatch"></i>${escapeHtml(opts.label)}</span><span class="tip-val">${kw(p.v)}</span>`,
    ];
    if (p.e != null)
      rows.push(`<span class="tip-key"><i class="tip-swatch tip-swatch--typical"></i>Typical for this hour</span><span class="tip-val">${kw(p.e)}</span>`);
    if (p.raw != null && Math.abs(p.raw - p.v) > 0.05)
      rows.push(`<span class="tip-key">Unsmoothed sample</span><span class="tip-val">${kw(p.raw)}</span>`);
    tooltip.innerHTML = `<div class="tip-time">${clockTime(p.t)}</div>${rows
      .map((r) => `<div class="tip-row">${r}</div>`)
      .join('')}`;
    tooltip.hidden = false;
    const cw = container.clientWidth;
    const tw = tooltip.offsetWidth || 180;
    let left = x(i) + 12;
    if (left + tw > cw - 4) left = x(i) - tw - 12;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, y(p.v) - 12)}px`;
  }

  function indexFromClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const { innerW } = scales();
    const rel = clientX - rect.left - opts.padLeft;
    const frac = Math.max(0, Math.min(1, rel / Math.max(1, innerW)));
    return Math.round(frac * (state.series.length - 1));
  }

  hit.addEventListener('pointermove', (e) => {
    state.focus = indexFromClientX(e.clientX);
    setFocus(state.focus);
  });
  hit.addEventListener('pointerleave', () => {
    state.focus = -1;
    setFocus(-1);
  });
  container.tabIndex = 0;
  container.addEventListener('keydown', (e) => {
    if (!state.series.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const start = state.focus < 0 ? state.series.length - 1 : state.focus;
      state.focus = Math.max(0, Math.min(state.series.length - 1, start + dir));
      setFocus(state.focus);
    } else if (e.key === 'Escape') {
      state.focus = -1;
      setFocus(-1);
    }
  });
  container.addEventListener('blur', () => {
    state.focus = -1;
    setFocus(-1);
  });

  return {
    update(series, refs = []) {
      state.series = series || [];
      state.refs = refs;
      draw();
    },
    /** Re-fit the plot to a panel of fixed height (control-room wall layout). */
    setHeight(h) {
      const next = Math.max(70, Math.round(h));
      if (next === opts.height) return;
      opts.height = next;
      draw();
    },
    destroy() {
      ro.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// Sparkline — trend at a glance, no axes. History in the de-emphasis hue,
// the current point marked in the accent.
// ---------------------------------------------------------------------------

export function sparklineSvg(values, { w = 96, h = 26, expected = null } = {}) {
  const pts = (values || []).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (expected != null && Number.isFinite(expected)) {
    lo = Math.min(lo, expected);
    hi = Math.max(hi, expected);
  }
  if (hi === lo) hi = lo + 1;
  const pad = 3;
  const x = (i) => (i / (pts.length - 1)) * (w - 2 * pad) + pad;
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ref =
    expected != null && Number.isFinite(expected)
      ? `<line class="spark-ref" x1="${pad}" x2="${w - pad}" y1="${y(expected).toFixed(1)}" y2="${y(expected).toFixed(1)}"/>`
      : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${ref}<path class="spark-line" d="${d}"/><circle class="spark-dot" cx="${x(
    pts.length - 1
  ).toFixed(1)}" cy="${y(pts[pts.length - 1]).toFixed(1)}" r="2.75"/></svg>`;
}

// ---------------------------------------------------------------------------
// Single-line diagram — feeder → bus → substation → load groups.
// Mirrors how the plant is actually wired, so no translation is needed.
// ---------------------------------------------------------------------------

export function renderSld(container, substations, rollups, severityOf) {
  const subs = substations.filter((s) => !s.standalone);
  const W = 720;
  const H = 210;
  const busY = 46;
  const slotW = W / subs.length;

  const parts = [];
  parts.push(`<text x="16" y="24" class="sld-caption">11 kV incoming</text>`);
  parts.push(`<line class="sld-bus" x1="16" y1="${busY}" x2="${W - 16}" y2="${busY}"/>`);
  parts.push(`<text x="${W - 16}" y="${busY - 10}" class="sld-caption" text-anchor="end">Main bus</text>`);

  subs.forEach((ss, i) => {
    const cx = slotW * i + slotW / 2;
    const r = rollups[ss.id] || { loadKw: 0 };
    const pct = ss.capacityKw ? Math.min(150, (r.loadKw / ss.capacityKw) * 100) : 0;
    const sev = severityOf(ss.id);
    const boxY = 92;
    parts.push(`<line class="sld-drop" x1="${cx}" y1="${busY}" x2="${cx}" y2="${boxY}"/>`);
    // VCB symbol where the register says one exists
    if (ss.hasVcb) {
      parts.push(
        `<g><rect class="sld-vcb" x="${cx - 7}" y="${busY + 14}" width="14" height="14" rx="2"/><title>VCB HT 11 kV</title></g>`
      );
    }
    parts.push(`<g class="sld-node sld-node--${sev}">
      <rect class="sld-box" x="${cx - 92}" y="${boxY}" width="184" height="84" rx="8"/>
      <text class="sld-name" x="${cx}" y="${boxY + 22}" text-anchor="middle">${escapeHtml(ss.name)}</text>
      <text class="sld-tag" x="${cx}" y="${boxY + 37}" text-anchor="middle">${escapeHtml(ss.incomerTag || ss.id)}</text>
      <rect class="sld-track" x="${cx - 74}" y="${boxY + 48}" width="148" height="6" rx="3"/>
      <rect class="sld-fill" x="${cx - 74}" y="${boxY + 48}" width="${(Math.min(100, pct) / 100) * 148}" height="6" rx="3"/>
      <text class="sld-load" x="${cx - 74}" y="${boxY + 72}">${kw(r.loadKw)}</text>
      <text class="sld-cap" x="${cx + 74}" y="${boxY + 72}" text-anchor="end">${Math.round(pct)}% of ${(
      ss.capacityKw || 0
    ).toLocaleString('en-US')} kW</text>
    </g>`);
  });

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="sld-svg" role="img" aria-label="Single-line feeder diagram">${parts.join(
    ''
  )}</svg>`;
}

// ---------------------------------------------------------------------------
// Grouped bar chart (management view) — one series, one colour, values at the tip
// ---------------------------------------------------------------------------

export function renderBars(container, rows, { max = null, unit = 'kW' } = {}) {
  const hi = max ?? Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  container.innerHTML = rows
    .map((r) => {
      const w = Math.max(0, Math.min(100, (Math.abs(r.value) / hi) * 100));
      return `<div class="bar-row">
        <div class="bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
        <div class="bar-track"><div class="bar-fill bar-fill--${r.severity || 'none'}" style="width:${w}%"></div></div>
        <div class="bar-value">${unit === 'kW' ? kw(r.value) : r.display}</div>
      </div>`;
    })
    .join('');
}
