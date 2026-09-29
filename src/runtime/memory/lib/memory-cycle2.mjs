// Cycle 2 maintains searchable history. It never writes standing memory or
// changes the legacy active/archived classification.
import { flushEmbeddingDirty } from './memory-embed.mjs';
import { holdEmbeddingWarm } from './embedding-provider.mjs';
import {
  quarantinedIds,
  recordReviewFailure,
  recordReviewSuccess,
  reviewPausedUntil,
} from './memory-cycle2-quarantine.mjs';
import { reviewHistory } from './memory-cycle2-review.mjs';
import { applyHistoryReview } from './memory-cycle2-mutations.mjs';
import { __mixdogMemoryLog, throwIfAborted, isStoreFault } from './memory-cycle2-shared.mjs';
import {
  markCycleRequest,
  consumeCycleRequests,
  resolveCoalesceMaxDrains,
  scheduleCoalescedCycleRetry,
  makeCycleRequestSignature,
  resolveCoalesceMaxRetries,
} from './memory-cycle-requests.mjs';

const inFlight = new WeakMap();
const emptyResult = () => ({ processed: 0, kept: 0, merged: 0, linked: 0, held: 0, deferred: 0 });

async function maintainHistory(db, config, options, result) {
  const { signal } = options;
  throwIfAborted(signal);
  const now = (options.now ?? Date.now)();
  // While review is paused or a failing batch is cooling down / dead-lettered,
  // its rows stay out of selection, so nothing re-enqueues them.
  // Only automatic (scheduler/coalesced) runs are contained; an explicit
  // user-requested run always reviews and surfaces its own failure.
  const automatic = options.coalescedRetry === true;
  const excluded = !automatic ? [] : reviewPausedUntil(db) > now ? null : quarantinedIds(db, now);
  const rows = excluded
    ? (
        await db.query(
          `
    SELECT id, ts, element, summary, project_id
    FROM entries
    WHERE is_root = 1 AND cycle2_reviewed_at IS NULL AND duplicate_of IS NULL
      ${excluded.length ? 'AND NOT (id = ANY($2::bigint[]))' : ''}
    ORDER BY ts DESC, id DESC
    LIMIT $1
  `,
          [Math.max(1, Math.floor(Number(config.batch_size) || 50)), ...(excluded.length ? [excluded] : [])]
        )
      ).rows
    : [];
  if (rows.length) {
    // Backlog is being worked: keep the embed model resident between batches.
    holdEmbeddingWarm();
    const ids = rows.map((row) => Number(row.id));
    let review;
    try {
      review = await reviewHistory(db, rows, config, options);
    } catch (error) {
      if (!automatic || signal?.aborted || isStoreFault(error)) throw error;
      const failure = recordReviewFailure(db, ids, error, config, now);
      if (failure.firstFailure && failure.raw !== null) {
        __mixdogMemoryLog(`[cycle2] invalid review output for batch ${failure.key}: ${failure.raw}\n`);
      }
      if (failure.dead) {
        __mixdogMemoryLog(
          `[cycle2] batch ${failure.key} (${ids.length} rows) dead-lettered after ${failure.fails} failures: ${error.message}\n`
        );
      }
      // Already backed off/dead-lettered here; a coalesced retry would only re-run it.
      error.cycle2Quarantined = true;
      throw error;
    }
    recordReviewSuccess(db, ids);
    result.deferred += review.deferredIds.length;
    // Validate every packet before applying any verdict. Bad model output
    // leaves the queue intact and is a failed run, not a successful no-op.
    for (const { row, actions } of review.verdicts) {
      throwIfAborted(signal);
      const applied = await applyHistoryReview(db, row, actions);
      if (!applied) {
        result.held++;
        continue;
      }
      result.processed++;
      if (!actions.length) result.kept++;
      for (const { action } of actions) result[action === 'merge' ? 'merged' : 'linked']++;
    }
  }
  throwIfAborted(signal);
  const embeddings = await (options.flushEmbeddings ?? flushEmbeddingDirty)(db, { signal });
  if (embeddings?.timedOut || embeddings?.failed?.length) {
    throw new Error(
      `cycle2 embedding maintenance incomplete: failed=${embeddings.failed?.length || 0} timedOut=${Boolean(embeddings.timedOut)}`
    );
  }
  return result;
}

export async function runCycle2(db, config = {}, options = {}) {
  const { signal } = options;
  throwIfAborted(signal);
  const retry = options.coalescedRetry === true;
  const attempt = Math.max(0, Number(options.coalescedRetryAttempt) || 0);
  const maxRetries = resolveCoalesceMaxRetries(config, 3);
  const signature = makeCycleRequestSignature('cycle2', config, { concurrency: options.concurrency });
  const scheduleRetry = () =>
    scheduleCoalescedCycleRetry(
      db,
      'cycle2',
      () =>
        runCycle2(db, config, {
          ...options,
          signal: undefined,
          coalescedRetry: true,
          catchUpDrainPass: false,
          coalescedRetryAttempt: attempt + 1,
        }),
      config,
      signature
    );
  const skipped = async (reason) => {
    if (!retry) await markCycleRequest(db, 'cycle2', reason, signature);
    if (!retry || attempt < maxRetries) scheduleRetry();
    return { ok: true, ...emptyResult(), skippedInFlight: true };
  };
  if (inFlight.has(db)) return await skipped('in-flight');
  const client = await db._pool.connect();
  let locked;
  try {
    throwIfAborted(signal);
    locked =
      (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS got', ['mixdog.cycle2'])).rows[0]?.got === true;
  } catch (error) {
    client.release();
    throw error;
  }
  if (!locked) {
    client.release();
    return await skipped('advisory-lock');
  }
  const promise = (async () => {
    const result = emptyResult();
    try {
      if (retry && !options.catchUpDrainPass) {
        if ((await consumeCycleRequests(db, 'cycle2', signature)) <= 0) {
          return { ok: true, ...result, coalescedRetryNoop: true };
        }
      }
      await maintainHistory(db, config, options, result);
      const maxDrains = options.catchUpDrainPass ? 0 : resolveCoalesceMaxDrains(config, 1);
      for (let i = 0; i < maxDrains; i++) {
        throwIfAborted(signal);
        if ((await consumeCycleRequests(db, 'cycle2', signature)) <= 0) break;
        await maintainHistory(db, config, options, result);
      }
      const success = { ok: true, ...result };
      if (retry && typeof options.onCoalescedSuccess === 'function') await options.onCoalescedSuccess(success);
      return success;
    } catch (error) {
      throwIfAborted(signal);
      // Do not write retry metadata after an ambiguous store failure.
      if (retry && !isStoreFault(error) && !error.cycle2Quarantined) {
        await markCycleRequest(db, 'cycle2', 'retry-error', signature);
      }
      if (retry && attempt < maxRetries && !error.cycle2Quarantined) scheduleRetry();
      __mixdogMemoryLog(`[cycle2] history maintenance failed: ${error.message}\n`);
      return { ok: false, ...result, error: error.message, storeFault: isStoreFault(error) };
    } finally {
      let releaseError;
      try {
        const released = await client.query('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', ['mixdog.cycle2']);
        if (released.rows[0]?.unlocked !== true) releaseError = new Error('cycle2 advisory unlock returned false');
      } catch (error) {
        releaseError = error;
      }
      client.release(releaseError);
    }
  })();
  inFlight.set(db, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(db);
  }
}

export function parseInterval(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!match) throw new Error(`[memory-cycle2] invalid interval config: ${value}`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}
