// Formatting helpers shared by the session-bench analysis and render layers.
export function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(n)}ms`;
}

export function fmtSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
}

export function fmtTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

export function fmtPct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${Math.round(v)}%` : '-';
}

export function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(n)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

export function compactText(value, max = 140) {
  const s = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export function shortId(id) {
  const s = String(id || '');
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

export function padTable(rows) {
  if (!rows.length) return [];
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell ?? '').length);
    });
  }
  return rows.map((row) => row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  '));
}

export function fmtKindCounts(counts, limit = 3) {
  const shown = (counts || []).slice(0, limit).map((x) => `${x.kind}×${x.count}`);
  const hidden = Math.max(0, (counts || []).length - shown.length);
  return `${shown.join(', ')}${hidden ? ` +${hidden}` : ''}` || '-';
}
