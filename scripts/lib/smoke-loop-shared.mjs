// Duration parsing and min/max/avg summaries shared by smoke-loop (the runner)
// and smoke-loop-report (its reader).
import { DURATION_UNIT_MS } from './parse-since.mjs';

// `90000`, `500ms`, `30s`, `5m`, `2h` → milliseconds. Empty → fallback.
export function parseDuration(value, fallback = null) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new Error(`invalid duration: ${raw}`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = DURATION_UNIT_MS[unit];
  return Math.max(1, Math.floor(n * mult));
}

export function summarize(values) {
  if (!values.length) return { min: 0, max: 0, avg: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    avg: Math.round(avg * 10) / 10,
  };
}
