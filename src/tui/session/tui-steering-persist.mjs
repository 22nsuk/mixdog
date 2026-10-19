// Lead TUI busy-input steering queue — disk mirror of in-memory `pending`
// (same store as manager pending-messages, lead-scoped session key).
import { randomBytes } from 'node:crypto';
import { touchPendingSessionEntry } from '../../runtime/agent/orchestrator/session/manager/pending-spool-path.mjs';
import { updatePendingShard } from '../../runtime/agent/orchestrator/session/manager/pending-spool-shard.mjs';
import { promptContentText } from './queue-helpers.mjs';
// Restore window for persisted busy-input steering rows. Rows older than this
// are leftovers of a session that ended long ago — restoring them into a fresh
// TUI boot reads as a surprise self-injection (user report), so they are
// discarded when the mirror is read instead.
const STALE_STEERING_RESTORE_TTL_MS = 30 * 60 * 1000;

// Serialize this UI process's own steering writes so append→drop→read keep
// their issue order even though each now waits on the lock asynchronously.
// Cross-process mutual exclusion still comes from the shared lock protocol;
// this chain only orders same-process operations that were previously
// naturally ordered by the synchronous call site.
// One chain per session key so a slow write for one session never delays
// another; an entry is removed once its chain is idle.
const _persistChains = new Map();
function _serialize(key, task) {
  const prev = _persistChains.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  // Never let a rejection poison the chain; each op logs its own error.
  const tail = run
    .catch(() => {})
    .then(() => {
      if (_persistChains.get(key) === tail) _persistChains.delete(key);
    });
  _persistChains.set(key, tail);
  return run;
}

// Best-effort diagnostic line; stderr can be closed during teardown.
function writeSteeringDiagnostic(line) {
  try {
    process.stderr.write(`[tui] ${line}\n`);
  } catch {}
}

// Per-row timestamps age precisely; legacy rows without one age from the
// session key's last touch time.
function isStaleSteeringRow(row, touchedAt, now) {
  const at = Number(row?.at) || touchedAt;
  return at > 0 && now - at > STALE_STEERING_RESTORE_TTL_MS;
}

function deleteSessionBucket(next, key) {
  delete next.sessions[key];
  if (next.sessionTouchedAt) delete next.sessionTouchedAt[key];
}

function tuiSteeringSessionKey(leadSessionId) {
  if (typeof leadSessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(leadSessionId)) return null;
  return `tui_${leadSessionId}`;
}

function newSteeringPersistId() {
  return `ts_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

// Daemon intake has already externalized attachment bytes. Keep its content
// and restoration metadata, plus the options that decide how the queued user
// input runs; callbacks and other live queue state never belong in the spool.
function persistedQueuePayload(entry) {
  const out = {};
  if (typeof entry.content === 'string' || Array.isArray(entry.content)) out.content = entry.content;
  for (const field of ['pastedImages', 'pastedTexts', 'transcriptMeta']) {
    if (entry[field] && typeof entry[field] === 'object' && !Array.isArray(entry[field])) {
      out[field] = entry[field];
    }
  }
  for (const field of ['mode', 'priority', 'context', 'retryTurnId', 'retryAttemptId']) {
    if (typeof entry[field] === 'string' && entry[field]) out[field] = entry[field];
  }
  for (const field of ['skipSlashCommands', 'suppressDisplay', 'retryFailedTurn']) {
    if (entry[field] === true) out[field] = true;
  }
  return out;
}

function normalizeTuiSteeringQueueEntry(entry) {
  if (typeof entry === 'string') entry = { text: entry };
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.text === 'string' && entry.text.trim()) {
    const text = entry.text.trim();
    // Legacy text-only/idless rows receive their identity under the shard
    // lock. A read persists it before exposing the row, so later restores and
    // explicit reclamation can identify the same row without comparing text.
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : newSteeringPersistId();
    const submissionId =
      typeof entry.submissionId === 'string' && entry.submissionId.trim() ? entry.submissionId.trim() : null;
    const submittedAt = Number(entry.submittedAt);
    const at = Number(entry.at);
    return {
      id,
      text,
      ...persistedQueuePayload(entry),
      ...(Number.isFinite(at) && at > 0 ? { at } : {}),
      ...(submissionId ? { submissionId } : {}),
      ...(Number.isFinite(submittedAt) && submittedAt > 0 ? { submittedAt } : {}),
    };
  }
  return null;
}

function normalizePendingStore(raw) {
  const sessions =
    raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  const storeUpdatedAt = Number(raw?.updatedAt) || Date.now();
  const touchedRaw =
    raw && typeof raw === 'object' && raw.sessionTouchedAt && typeof raw.sessionTouchedAt === 'object'
      ? raw.sessionTouchedAt
      : {};
  const out = { version: 1, updatedAt: storeUpdatedAt, sessions: {}, sessionTouchedAt: {} };
  for (const [sid, value] of Object.entries(sessions)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    if (!sid.startsWith('tui_')) {
      // FOREIGN bucket. This file is SHARED with the runtime/manager pending
      // -message spool, and every TUI write passes the whole store through
      // here. Flattening those rows to plain strings destroyed id,
      // enqueuedAt, options, structured content and the notification markers.
      // Rows this process does not own are copied through UNCHANGED (array
      // copy only, so nothing here can alias-mutate them either).
      out.sessions[sid] = value.slice();
      const foreignTouched = Number(touchedRaw[sid]);
      // Carry an existing stamp only: inventing one would reset the runtime's
      // own orphan aging for a session this process does not own.
      if (Number.isFinite(foreignTouched) && foreignTouched > 0) {
        out.sessionTouchedAt[sid] = foreignTouched;
      }
      continue;
    }
    // TUI-owned bucket: the only rows this module may reshape.
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) continue;
    const q = value.map(normalizeTuiSteeringQueueEntry).filter(Boolean);
    if (q.length === 0) continue;
    out.sessions[sid] = q;
    const touched = Number(touchedRaw[sid]);
    out.sessionTouchedAt[sid] = Number.isFinite(touched) && touched > 0 ? touched : storeUpdatedAt;
  }
  return out;
}

function entryPersistText(entry) {
  if (!entry) return '';
  const text =
    typeof entry.text === 'string' && entry.text.trim()
      ? entry.text.trim()
      : promptContentText(entry.content ?? entry.text ?? '').trim();
  return text;
}

function rowMatchesEntry(row, entry) {
  const persistId = entry?.steeringPersistId;
  if (persistId) {
    return Boolean(row && typeof row === 'object' && row.id === persistId);
  }
  const text = entryPersistText(entry);
  if (!text) return false;
  return (
    row === text ||
    (row && typeof row === 'object' && !row.submissionId && !Object.hasOwn(row, 'content') && row.text === text)
  );
}

function removePersistRow(q, entry) {
  const idx = q.findIndex((row) => rowMatchesEntry(row, entry));
  if (idx >= 0) q.splice(idx, 1);
}

// Consistency-required: a dropped append loses a user's queued steering
// message, so we async-wait for the lock (never try-once). Returns a promise;
// fire-and-forget at call sites is fine — _serialize keeps append/drop/read
// in issue order and the write never blocks the render loop.
export function appendTuiSteeringPersist(leadSessionId, entry) {
  const text = entryPersistText(entry);
  if (!text) return Promise.resolve();
  const key = tuiSteeringSessionKey(leadSessionId);
  if (!key) return Promise.resolve();
  if (!entry.steeringPersistId) entry.steeringPersistId = newSteeringPersistId();
  const submissionId = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
  const submittedAt = Number(entry.submittedAt);
  let record;
  try {
    // Capture JSON data now, before the async lock wait: later queue edits
    // cannot mutate the accepted submission's durable snapshot.
    record = JSON.parse(
      JSON.stringify({
        id: entry.steeringPersistId,
        text,
        ...persistedQueuePayload(entry),
        at: Date.now(),
        ...(submissionId ? { submissionId } : {}),
        ...(Number.isFinite(submittedAt) && submittedAt > 0 ? { submittedAt } : {}),
      })
    );
  } catch (err) {
    writeSteeringDiagnostic(`steering-queue append failed sessionId=${leadSessionId}: ${err?.message || err}`);
    return Promise.resolve(false);
  }
  return _serialize(key, async () => {
    try {
      await updatePendingShard(key, (raw) => {
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[key]) ? next.sessions[key] : [];
        q.push(record);
        next.sessions[key] = q;
        const now = Date.now();
        next.updatedAt = now;
        touchPendingSessionEntry(next, key, now);
        return next;
      });
      return true;
    } catch (err) {
      writeSteeringDiagnostic(`steering-queue append failed sessionId=${leadSessionId}: ${err?.message || err}`);
      return false;
    }
  });
}

export function dropTuiSteeringPersist(leadSessionId, entries) {
  const key = tuiSteeringSessionKey(leadSessionId);
  if (!key) return Promise.resolve();
  const batch = Array.isArray(entries) ? entries : [];
  if (batch.length === 0) return Promise.resolve();
  return _serialize(key, async () => {
    try {
      await updatePendingShard(key, (raw) => {
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[key]) ? next.sessions[key].slice() : [];
        if (q.length === 0) return undefined;
        for (const entry of batch) {
          removePersistRow(q, entry);
        }
        if (q.length === 0) {
          deleteSessionBucket(next, key);
        } else {
          next.sessions[key] = q;
        }
        next.updatedAt = Date.now();
        return next;
      });
    } catch (err) {
      writeSteeringDiagnostic(`steering-queue drop failed sessionId=${leadSessionId}: ${err?.message || err}`);
    }
  });
}

export async function flushTuiSteeringPersist() {
  // Loop: chains started while waiting are awaited too.
  while (_persistChains.size > 0) {
    await Promise.all([..._persistChains.values()]);
  }
}

// Test hook: number of live per-key chains.
export function _steeringPersistChainCount() {
  return _persistChains.size;
}

function persistedRowToRestore(row) {
  if (row && typeof row === 'object' && typeof row.text === 'string') {
    return {
      text: row.text,
      ...persistedQueuePayload(row),
      steeringPersistId: typeof row.id === 'string' ? row.id : null,
      submissionId: typeof row.submissionId === 'string' ? row.submissionId : null,
      submittedAt: Number.isFinite(Number(row.submittedAt)) ? Number(row.submittedAt) : null,
    };
  }
  return null;
}

// Restore is a read, not delivery: fresh rows stay durable until the queue's
// commit/reclaim/close path explicitly drops them. The same shard lock makes
// legacy identity upgrades, stale removal and append/drop ordering atomic.
export function readTuiSteeringPersist(leadSessionId) {
  const key = tuiSteeringSessionKey(leadSessionId);
  if (!key) return Promise.resolve([]);
  return _serialize(key, async () => {
    let restored = [];
    let droppedStale = 0;
    try {
      await updatePendingShard(key, (raw) => {
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[key]) ? next.sessions[key] : [];
        const now = Date.now();
        const touchedAt = Number(next.sessionTouchedAt?.[key]) || 0;
        droppedStale = 0;
        const fresh = q.filter((row) => {
          const stale = isStaleSteeringRow(row, touchedAt, now);
          if (stale) droppedStale += 1;
          return !stale;
        });
        restored = fresh.map(persistedRowToRestore).filter(Boolean);
        if (restored.length === 0 && droppedStale === 0) return undefined;
        const previous = Array.isArray(raw?.sessions?.[key]) ? raw.sessions[key] : [];
        if (JSON.stringify(previous) === JSON.stringify(fresh)) return undefined;
        if (fresh.length > 0) next.sessions[key] = fresh;
        else deleteSessionBucket(next, key);
        next.updatedAt = Date.now();
        return next;
      });
    } catch (err) {
      // In particular, never expose an identity whose upgrade did not reach
      // disk: another read would otherwise mint a second identity for it.
      restored = [];
      droppedStale = 0;
      writeSteeringDiagnostic(`steering-queue read failed sessionId=${leadSessionId}: ${err?.message || err}`);
    }
    if (droppedStale > 0) {
      writeSteeringDiagnostic(`dropped ${droppedStale} stale steering row(s) sessionId=${leadSessionId}`);
    }
    return restored;
  });
}
