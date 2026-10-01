// worker-index/row-store.mjs
// The on-disk worker index file: an mtime-keyed parse cache in front of it and
// the single in-process writer queue that republishes rows + tombstones.
import { readFileSync, statSync } from 'node:fs';

import { createIndexWriteQueue } from '../index-write-queue.mjs';
import { normalizeTagTombstones, tagTombstoneKey, workerRowKey } from '../worker-rows.mjs';
import { keepWorkerRow, normalizeWorkerRows } from './row-shape.mjs';

/** One rewrite: the current document as keyed maps, the caller's mutator over
 *  them, then the v2 document to publish. */
function rewriteIndexDocument(cur, mutator) {
  const byKey = new Map();
  for (const row of normalizeWorkerRows(cur)) {
    const key = workerRowKey(row);
    if (key) byKey.set(key, row);
  }
  const tombstonesByKey = new Map();
  for (const row of normalizeTagTombstones(cur, { cap: false })) {
    tombstonesByKey.set(tagTombstoneKey(row), row);
  }
  const priorityTombstoneKeys = new Set();
  mutator(byKey, tombstonesByKey, priorityTombstoneKeys);
  const workers = {};
  for (const row of [...byKey.values()].filter(keepWorkerRow)) {
    const key = workerRowKey(row);
    if (key) workers[key] = row;
  }
  const tombstones = {};
  for (const row of normalizeTagTombstones(
    { tombstones: [...tombstonesByKey.values()] },
    { priorityKeys: priorityTombstoneKeys }
  )) {
    tombstones[tagTombstoneKey(row)] = row;
  }
  return { version: 2, updatedAt: new Date().toISOString(), workers, tombstones };
}

/** `file` may be null (no data dir): reads are empty and writes are no-ops. */
export function createWorkerRowStore(file) {
  // Mtime-keyed parse cache. A single spawn calls refreshTagsFromSessions /
  // resolveTag / nextTag, which each re-read and re-parse this file; across a
  // parallel fanout that is O(spawns^2) synchronous reads of the same bytes.
  let cache = null; // { mtimeMs, size, parsed, rows, tombstones }
  let dirty = true;
  // Unpersisted writes: reads are served from the queue's projection so a
  // caller sees its own write before the async persist lands.
  let projected = null; // { version, rows, tombstones }

  const queue = createIndexWriteQueue({
    file,
    rewrite: rewriteIndexDocument,
    // A fresh disk read: the cache stat can collide with another process's write.
    readDoc: () => {
      dirty = true;
      readAll();
      return cache?.parsed ?? null;
    },
    // The file changed: force the next read to re-parse even if the new
    // mtime/size happen to collide with the cached stat.
    onPersisted: () => {
      dirty = true;
    },
  });

  function projectedView() {
    const doc = queue.projection();
    if (!doc) return null;
    if (!projected || projected.version !== queue.version()) {
      projected = { version: queue.version(), rows: normalizeWorkerRows(doc), tombstones: normalizeTagTombstones(doc) };
    }
    return projected;
  }

  function readAll() {
    if (!file) return [];
    const view = projectedView();
    if (view) return view.rows;
    let st = null;
    try {
      st = statSync(file);
    } catch {
      cache = null;
      return [];
    }
    if (!dirty && cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.rows;
    let rows = [];
    let tombstones = [];
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
      rows = normalizeWorkerRows(parsed);
      tombstones = normalizeTagTombstones(parsed);
    } catch {
      parsed = null;
      rows = [];
      tombstones = [];
    }
    cache = { mtimeMs: st.mtimeMs, size: st.size, parsed, rows, tombstones };
    dirty = false;
    return rows;
  }

  // Rows and tombstones must come from the same read/projection. In
  // particular, do not stat and reload the file between the two collections.
  function readSnapshot() {
    const rows = readAll();
    return { rows, tombstones: (projectedView() || cache)?.tombstones || [] };
  }

  function readTombstones() {
    return readSnapshot().tombstones;
  }

  // Single writer path: the mutator runs now over keyed maps against the
  // in-process projection (see index-write-queue.mjs); its effect is
  // republished as rows + tombstones by one async locked writer.
  const write = (mutator) => queue.write(mutator);

  return {
    readAll,
    readSnapshot,
    readTombstones,
    write,
    /** Resolves once every write so far is on disk. */
    flush: queue.flush,
    /** Exit path: persist what is still queued, synchronously. */
    flushSync: queue.flushSync,
    invalidate: () => {
      dirty = true;
    },
  };
}
