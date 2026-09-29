// Accessors for agent-trace JSONL rows, shared by the trace CLIs (session-bench,
// session-diag, llm-trace-summary, routing-corpus, internal-comms-bench). A
// field lives either on the row itself or inside its `payload` object.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// The trace files a CLI reads, rotated file first: an explicit --path, else the
// history dir of --data-dir, else the current project's and the user's data dir.
export function defaultTraceFiles({ pathArg = null, dataDir = null } = {}) {
  if (pathArg) return [resolve(pathArg)];
  const mixdogHome = process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog');
  const mixdogDataDir = process.env.MIXDOG_DATA_DIR || resolve(mixdogHome, 'data');
  const dirs = dataDir ? [resolve(dataDir)] : [resolve(process.cwd(), '.mixdog', 'data'), mixdogDataDir];
  const files = dirs.flatMap((dir) => [
    resolve(dir, 'history', 'agent-trace.jsonl.1'),
    resolve(dir, 'history', 'agent-trace.jsonl'),
  ]);
  return [...new Set(files)];
}

export function payload(row) {
  return row?.payload && typeof row.payload === 'object' ? row.payload : {};
}

export function field(row, name) {
  if (row && row[name] != null) return row[name];
  const p = payload(row);
  return p[name] != null ? p[name] : null;
}

// The field coerced with Number(): null when the result is not finite. A
// missing field is Number(null) === 0, so it reads as 0 rather than null.
export function num(row, name) {
  const n = Number(field(row, name));
  return Number.isFinite(n) ? n : null;
}

export function sessionId(row) {
  return String(row?.session_id || row?.sessionId || field(row, 'session_id') || '');
}
