/**
 * Formatting — units and precision an operator can act on.
 * 452 kW, never 452.184 kW. Units travel with the number, never only in a header.
 */

/** Precision scales with magnitude: big numbers get no decimals, small ones get one. */
export function kw(v, { unit = true } = {}) {
  if (v == null || !Number.isFinite(v)) return unit ? '— kW' : '—';
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return unit ? `${s} kW` : s;
}

/** Compact form for hero/stat figures: 6,916 kW / 12.9 MW. */
export function kwCompact(v, { unit = true } = {}) {
  if (v == null || !Number.isFinite(v)) return unit ? '— kW' : '—';
  if (Math.abs(v) >= 10000) {
    const s = (v / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return unit ? `${s} MW` : s;
  }
  return kw(v, { unit });
}

export function kwh(v) {
  if (v == null || !Number.isFinite(v)) return '— kWh';
  if (Math.abs(v) >= 1000)
    return `${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} MWh`;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} kWh`;
}

export function pct(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** Signed percentage, for "vs typical" deltas. */
export function signedPct(ratio, digits = 0) {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const v = ratio * 100;
  const sign = v > 0.5 ? '+' : '';
  return `${sign}${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function clockTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

export function dateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', { hour12: false });
}

/** "4s ago" / "2m 10s ago" — staleness must be legible at a glance. */
export function since(ts, now = Date.now()) {
  if (!ts || !Number.isFinite(ts)) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Escape a value for a CSV cell. */
export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
