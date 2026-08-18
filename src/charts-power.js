/**
 * POWER-SYSTEM CHARTS
 * ===================
 * The chart forms specific to an electrical overview screen: a distribution
 * donut, an arc gauge, a multi-phase profile, and the single-line diagram.
 *
 * Trend/sparkline/bar forms live in charts.js.
 */

import { kw, clockTime, escapeHtml } from './format.js';
import { el, niceTicks } from './charts.js';

// ---------------------------------------------------------------------------
// Power-distribution donut
// Part-to-whole at a glance, capped at 6 segments. Every segment is also
// direct-labelled with value and share in the legend, so identity never rests
// on colour alone.
// ---------------------------------------------------------------------------

export function renderDonut(container, segments, { centreValue = '', centreLabel = '' } = {}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
  const R = 60;
  const STROKE = 19;
  const C = 2 * Math.PI * R;
  const GAP = 2.5; // surface gap between segments

  let offset = 0;
  const arcs = segments
    .map((s, i) => {
      const frac = Math.max(0, s.value) / total;
      const len = Math.max(0, frac * C - GAP);
      const arc =
        `<circle class="donut-seg" r="${R}" cx="0" cy="0" fill="none"` +
        ` stroke="var(--cat-${i + 1})" stroke-width="${STROKE}"` +
        ` stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"` +
        ` transform="rotate(-90)"><title>${escapeHtml(s.label)}: ${kw(s.value)}</title></circle>`;
      offset += frac * C;
      return arc;
    })
    .join('');

  const legend = segments
    .map(
      (s, i) =>
        `<li class="dl-row">` +
        `<span class="dl-key"><i class="dl-dot" style="background:var(--cat-${i + 1})"></i>${escapeHtml(s.label)}</span>` +
        `<span class="dl-val">${kw(s.value)}</span>` +
        `<span class="dl-pct">${((Math.max(0, s.value) / total) * 100).toFixed(1)}%</span>` +
        `</li>`
    )
    .join('');

  container.innerHTML =
    `<div class="donut-wrap">` +
    `<svg viewBox="-78 -78 156 156" class="donut-svg" role="img" aria-label="Power distribution by source">` +
    `<g>${arcs}</g>` +
    `<text class="donut-centre-v" x="0" y="0" text-anchor="middle">${escapeHtml(centreValue)}</text>` +
    `<text class="donut-centre-l" x="0" y="16" text-anchor="middle">${escapeHtml(centreLabel)}</text>` +
    `</svg>` +
    `<ul class="donut-legend">${legend}</ul>` +
    `</div>`;
}

// ---------------------------------------------------------------------------
// Arc gauge — a single figure against a target
// ---------------------------------------------------------------------------

export function renderGauge(container, { value, max, unit = '', caption = '', target = null, targetLabel = '' }) {
  const R = 66;
  const W = 13;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  const pt = (f) => {
    const a = Math.PI - f * Math.PI;
    return [Math.cos(a) * R, -Math.sin(a) * R];
  };
  const arcPath = (f0, f1) => {
    const [x0, y0] = pt(f0);
    const [x1, y1] = pt(f1);
    // large-arc-flag is always 0: a half-circle gauge never sweeps past 180 deg.
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  const sev = frac > 0.95 ? 'critical' : frac > 0.85 ? 'warning' : 'ok';
  let targetMark = '';
  if (target != null && max > 0) {
    const tf = Math.max(0, Math.min(1, target / max));
    const [tx, ty] = pt(tf);
    targetMark =
      `<line class="gauge-target" x1="${(tx * 0.8).toFixed(2)}" y1="${(ty * 0.8).toFixed(2)}"` +
      ` x2="${(tx * 1.14).toFixed(2)}" y2="${(ty * 1.14).toFixed(2)}"><title>Target ${targetLabel}</title></line>`;
  }

  container.innerHTML =
    `<div class="gauge-wrap">` +
    `<svg viewBox="-86 -80 172 100" class="gauge-svg" role="img" aria-label="${escapeHtml(caption)}">` +
    `<path class="gauge-track" d="${arcPath(0, 1)}" fill="none" stroke-width="${W}" stroke-linecap="round"/>` +
    `<path class="gauge-fill gauge-fill--${sev}" d="${arcPath(0, Math.max(0.002, frac))}" fill="none" stroke-width="${W}" stroke-linecap="round"/>` +
    targetMark +
    `<text class="gauge-value" x="0" y="-16" text-anchor="middle">${escapeHtml(String(value))}</text>` +
    `<text class="gauge-unit" x="0" y="2" text-anchor="middle">${escapeHtml(unit)}</text>` +
    `</svg>` +
    `<div class="gauge-caption">${escapeHtml(caption)}</div>` +
    `</div>`;
}

// ---------------------------------------------------------------------------
// Multi-series line chart — the 3-phase voltage profile with statutory limits
// ---------------------------------------------------------------------------

export function createMultiLineChart(container, options = {}) {
  const opts = {
    height: 180,
    padTop: 12,
    padRight: 58,
    padBottom: 24,
    padLeft: 42,
    unit: '',
    decimals: 2,
    ...options,
  };
  container.classList.add('chart');
  const svg = el('svg', { class: 'chart-svg', role: 'img' });
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(svg, tip);

  const gGrid = el('g', {});
  const gRefs = el('g', {});
  const gLines = el('g', {});
  const gAxis = el('g', {});
  const cross = el('line', { class: 'crosshair' });
  const hit = el('rect', { class: 'chart-hit', fill: 'transparent' });
  svg.append(gGrid, gRefs, gLines, gAxis, cross, hit);
  cross.style.display = 'none';

  const state = { series: [], times: [], refs: [], w: 0 };
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  function scales() {
    const innerW = Math.max(10, state.w - opts.padLeft - opts.padRight);
    const innerH = Math.max(10, opts.height - opts.padTop - opts.padBottom);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of state.series) for (const v of s.values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const r of state.refs) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.18;
    lo -= pad;
    hi += pad;
    const n = Math.max(1, (state.series[0]?.values.length || 1) - 1);
    return {
      x: (i) => opts.padLeft + (i / n) * innerW,
      y: (v) => opts.padTop + innerH - ((v - lo) / (hi - lo)) * innerH,
      lo, hi, innerW, innerH,
    };
  }

  function draw() {
    state.w = Math.max(140, Math.round(container.getBoundingClientRect().width));
    svg.setAttribute('viewBox', `0 0 ${state.w} ${opts.height}`);
    svg.setAttribute('height', opts.height);
    hit.setAttribute('width', state.w);
    hit.setAttribute('height', opts.height);
    if (!state.series.length || !state.series[0].values.length) return;
    const { x, y, lo, hi, innerW, innerH } = scales();

    gGrid.replaceChildren();
    gAxis.replaceChildren();
    for (const t of niceTicks(lo, hi, 4)) {
      const yy = y(t);
      if (yy < opts.padTop - 2 || yy > opts.padTop + innerH + 2) continue;
      gGrid.append(el('line', { x1: opts.padLeft, x2: opts.padLeft + innerW, y1: yy, y2: yy, class: 'gridline' }));
      const lb = el('text', { x: opts.padLeft - 7, y: yy + 3.5, class: 'axis-label', 'text-anchor': 'end' });
      lb.textContent = opts.decimals ? t.toFixed(1) : t.toFixed(0);
      gAxis.append(lb);
    }

    const n = state.series[0].values.length;
    for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
      if (!state.times[i]) continue;
      const tx = el('text', {
        x: x(i),
        y: opts.height - 7,
        class: 'axis-label',
        'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
      });
      tx.textContent = clockTime(state.times[i]);
      gAxis.append(tx);
    }

    gRefs.replaceChildren();
    for (const r of state.refs) {
      const yy = y(r.value);
      if (yy < opts.padTop - 2 || yy > opts.padTop + innerH + 2) continue;
      gRefs.append(el('line', { x1: opts.padLeft, x2: opts.padLeft + innerW, y1: yy, y2: yy, class: `ref-line ref-${r.kind}` }));
      const lt = el('text', { x: opts.padLeft + innerW + 5, y: yy + 3.5, class: 'ref-label' });
      lt.textContent = r.label;
      gRefs.append(lt);
    }

    gLines.replaceChildren();
    state.series.forEach((s, si) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      gLines.append(el('path', { d, class: 'line-mark', style: `stroke:var(--cat-${si + 1})`, fill: 'none' }));
    });
  }

  hit.addEventListener('pointermove', (e) => {
    const n = state.series[0]?.values.length || 0;
    if (!n) return;
    const rect = svg.getBoundingClientRect();
    const { x, innerW } = scales();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - opts.padLeft) / Math.max(1, innerW)));
    const i = Math.round(frac * (n - 1));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('y1', opts.padTop);
    cross.setAttribute('y2', opts.height - opts.padBottom);
    cross.style.display = '';
    tip.innerHTML =
      `<div class="tip-time">${clockTime(state.times[i])}</div>` +
      state.series
        .map(
          (s, si) =>
            `<div class="tip-row"><span class="tip-key">` +
            `<i class="tip-swatch" style="background:var(--cat-${si + 1})"></i>${escapeHtml(s.label)}</span>` +
            `<span class="tip-val">${s.values[i].toFixed(opts.decimals)} ${escapeHtml(opts.unit)}</span></div>`
        )
        .join('');
    tip.hidden = false;
    const tw = tip.offsetWidth || 160;
    tip.style.left = `${Math.max(4, Math.min(container.clientWidth - tw - 4, x(i) + 12))}px`;
    tip.style.top = '4px';
  });
  hit.addEventListener('pointerleave', () => {
    cross.style.display = 'none';
    tip.hidden = true;
  });

  return {
    update(series, times, refs = []) {
      state.series = series;
      state.times = times || [];
      state.refs = refs;
      draw();
    },
    destroy() { ro.disconnect(); },
  };
}

// ---------------------------------------------------------------------------
// Single-line diagram — DOCUMENTED PLANT ONLY.
// The register evidences 11 kV VCBs, 3 substations, 3 feeders, 109 transformers
// and 13 solar systems. It records NO generators and NO 132 kV intake, so
// neither is drawn here.
// ---------------------------------------------------------------------------

export function renderSldFull(container, { substations, busses, solarKw, solarCount, fleet, severityOf }) {
  const W = 560;
  const H = 268;
  const gridY = 30;
  const busY = 88;
  const subs = substations.filter((s) => !s.standalone);
  const RAIL = 104;                       // right-hand strip reserved for the solar branch
  const slot = (W - 60 - RAIL) / subs.length;
  const p = [];

  p.push(`<text x="${W / 2}" y="13" class="sld-caption" text-anchor="middle">11 kV HT INTAKE — utility supply</text>`);
  p.push(
    `<g><rect class="sld-grid" x="${W / 2 - 48}" y="${gridY - 12}" width="96" height="24" rx="4"/>` +
      `<text class="sld-name" x="${W / 2}" y="${gridY + 5}" text-anchor="middle">11 kV GRID</text></g>`
  );
  p.push(`<line class="sld-drop" x1="${W / 2}" y1="${gridY + 12}" x2="${W / 2}" y2="${busY}"/>`);
  p.push(`<line class="sld-bus" x1="30" y1="${busY}" x2="${W - 24}" y2="${busY}"/>`);
  p.push(`<text x="32" y="${busY - 8}" class="sld-caption">MAIN 11 kV BUS</text>`);

  subs.forEach((ss, i) => {
    const cx = 30 + slot * i + slot / 2;
    const bus = busses.find((b) => b.id === ss.id) || {};
    const sev = severityOf(ss.id);
    const boxY = busY + 44;
    p.push(`<line class="sld-drop" x1="${cx}" y1="${busY}" x2="${cx}" y2="${boxY}"/>`);
    if (ss.hasVcb) {
      p.push(
        `<g><rect class="sld-vcb" x="${cx - 6}" y="${busY + 14}" width="12" height="12" rx="2"/>` +
          `<title>VCB HT 11 kV — listed in register</title></g>`
      );
    }
    const boxW = slot - 22;
    p.push(
      `<g class="sld-node sld-node--${sev}">` +
        `<rect class="sld-box" x="${cx - boxW / 2}" y="${boxY}" width="${boxW}" height="98" rx="7"/>` +
        `<text class="sld-name" x="${cx}" y="${boxY + 19}" text-anchor="middle">${escapeHtml(ss.name)}</text>` +
        `<text class="sld-tag" x="${cx}" y="${boxY + 33}" text-anchor="middle">${ss.transformerCount || 0} TX · ${(
          ss.installedKva || 0
        ).toLocaleString('en-US')} kVA</text>` +
        `<text class="sld-load" x="${cx}" y="${boxY + 56}" text-anchor="middle">${kw(bus.kw || 0)}</text>` +
        `<text class="sld-cap" x="${cx}" y="${boxY + 70}" text-anchor="middle">${(bus.currentA || 0).toFixed(0)} A · PF ${(
          bus.powerFactor || 0
        ).toFixed(2)}</text>` +
        `<rect class="sld-track" x="${cx - boxW / 2 + 14}" y="${boxY + 80}" width="${boxW - 28}" height="5" rx="2.5"/>` +
        `<rect class="sld-fill" x="${cx - boxW / 2 + 14}" y="${boxY + 80}" width="${(
          (Math.min(100, bus.loadingPct || 0) / 100) *
          (boxW - 28)
        ).toFixed(1)}" height="5" rx="2.5"/>` +
        `</g>`
    );
  });

  // Solar infeed — the register states 13 systems but gives no kW rating.
  const solY = busY + 60;
  const solX = W - RAIL / 2 - 16;
  p.push(`<line class="sld-drop sld-drop--solar" x1="${solX}" y1="${busY}" x2="${solX}" y2="${solY - 15}"/>`);
  p.push(
    `<g><rect class="sld-solar" x="${solX - 46}" y="${solY - 15}" width="92" height="36" rx="6"/>` +
      `<text class="sld-name" x="${solX}" y="${solY}" text-anchor="middle">SOLAR × ${solarCount}</text>` +
      `<text class="sld-cap" x="${solX}" y="${solY + 14}" text-anchor="middle">${kw(solarKw)}</text></g>`
  );

  p.push(
    `<text x="30" y="${H - 22}" class="sld-caption">${fleet.unitCount} transformers · ${fleet.installedKva.toLocaleString(
      'en-US'
    )} kVA installed</text>`
  );
  p.push(`<text x="30" y="${H - 8}" class="sld-caption sld-caption--note">No generators or 132 kV intake exist in the register</text>`);

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="sld-svg" role="img" aria-label="11 kV single line diagram">${p.join('')}</svg>`;
}
