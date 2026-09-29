// Failure containment for cycle2 review batches. A batch (its row-id set) that
// keeps failing is cooled down with exponential backoff, then dead-lettered:
// its rows are excluded from selection (so nothing re-enqueues them) until a
// timed re-arm. A run of consecutive failures across batches pauses review as a
// whole, so a systematically broken model/prompt cannot burn one LLM call per
// scheduler tick. State is in-process; a restart re-arms everything.
import { createHash } from 'node:crypto';

const DEFAULTS = { maxAttempts: 3, backoffMs: 30_000, rearmMs: 3_600_000 };
const RAW_LOG_LIMIT = 2000;

const states = new WeakMap();

function stateFor(db) {
  let state = states.get(db);
  if (!state) {
    state = { batches: new Map(), streak: 0, streakSignature: '', pausedUntil: 0 };
    states.set(db, state);
  }
  return state;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveQuarantinePolicy(config = {}) {
  return {
    maxAttempts: Math.floor(positive(config.failure_max_attempts, DEFAULTS.maxAttempts)),
    backoffMs: positive(config.failure_backoff_ms, DEFAULTS.backoffMs),
    rearmMs: positive(config.dead_letter_rearm_ms, DEFAULTS.rearmMs),
  };
}

function batchKey(ids) {
  return createHash('sha1')
    .update([...ids].map(Number).sort((a, b) => a - b).join(','))
    .digest('hex')
    .slice(0, 16);
}

/** Row ids currently cooling down or dead-lettered; expired entries re-arm. */
export function quarantinedIds(db, now = Date.now()) {
  const { batches } = stateFor(db);
  const ids = [];
  for (const [key, entry] of batches) {
    if (entry.until <= now) {
      // Cooldown elapsed: the batch may retry, keeping its failure count.
      // A dead-lettered batch that re-arms starts over.
      if (entry.dead) batches.delete(key);
      continue;
    }
    ids.push(...entry.ids);
  }
  return ids;
}

export function reviewPausedUntil(db) {
  return stateFor(db).pausedUntil;
}

export function recordReviewSuccess(db, ids) {
  const state = stateFor(db);
  state.batches.delete(batchKey(ids));
  state.streak = 0;
  state.streakSignature = '';
  state.pausedUntil = 0;
}

/**
 * Record a failed batch. Returns { fails, dead, firstFailure, key, raw } where
 * raw is the truncated invalid model output to log once (first failure only).
 */
export function recordReviewFailure(db, ids, error, config = {}, now = Date.now()) {
  const policy = resolveQuarantinePolicy(config);
  const state = stateFor(db);
  const key = batchKey(ids);
  const prior = state.batches.get(key);
  const fails = (prior?.fails ?? 0) + 1;
  const dead = fails >= policy.maxAttempts;
  const wait = dead ? policy.rearmMs : Math.min(policy.rearmMs, policy.backoffMs * 2 ** (fails - 1));
  state.batches.set(key, { ids: [...ids].map(Number), fails, dead, until: now + wait });
  const signature = String(error?.message ?? error);
  state.streak = signature === state.streakSignature ? state.streak + 1 : 1;
  state.streakSignature = signature;
  if (state.streak >= policy.maxAttempts) {
    const level = state.streak - policy.maxAttempts;
    state.pausedUntil = now + Math.min(policy.rearmMs, policy.backoffMs * 2 ** level);
  }
  const rawVerdict = error?.rawVerdict;
  return {
    key,
    fails,
    dead,
    firstFailure: fails === 1,
    raw: rawVerdict === undefined ? null : String(rawVerdict).slice(0, RAW_LOG_LIMIT),
  };
}
