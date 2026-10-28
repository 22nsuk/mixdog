// Owner-wide shell cancellation (session close) with the same pre-kill
// identity snapshot every other kill takes. Each live shell tree — a
// foreground run or a promoted background job — registers how to prepare its
// kill; the owner cancel prepares them all, waits for their snapshots at most
// PROCESS_TABLE_READ_BOUND_MS, and then sends the kill whether or not they
// arrived. A missing snapshot leaves the outcome unknown, so the workspace
// stays held under the observation loop instead of being released blind.
import { cancelNativeTasks } from './native-spawn-client.mjs';
import {
  killAfterSnapshot,
  PROCESS_TABLE_READ_BOUND_MS,
  TERMINATION_RECHECK_MS,
  withinBound,
} from './shell-descendants.mjs';

// One registration per job, preserved across a foreground/background handoff.
// Only unregistering its current entry proves that the whole lifecycle ended.
const ownedTrees = new Map();
const OWNER_CONFIRM_MS = TERMINATION_RECHECK_MS + PROCESS_TABLE_READ_BOUND_MS;
// owner -> send(): cancels still waiting for their snapshots. Runtime
// shutdown sends them at once — a kill is never lost to an exit.
const pendingCancels = new Map();

export function registerOwnedShellTree(jobId, entry) {
  const key = String(jobId || '').trim();
  if (!key || typeof entry?.prepareKill !== 'function') return;
  const previous = ownedTrees.get(key);
  if (previous) {
    previous.entry = entry;
    return;
  }
  let resolveTerminated;
  const terminated = new Promise((resolve) => {
    resolveTerminated = resolve;
  });
  ownedTrees.set(key, { entry, terminated, resolveTerminated });
}

/** Drops `entry` only while it is still the registered one for the job. */
export function unregisterOwnedShellTree(jobId, entry) {
  const key = String(jobId || '').trim();
  const registered = ownedTrees.get(key);
  if (registered?.entry !== entry) return;
  ownedTrees.delete(key);
  registered.resolveTerminated();
}

/** Prepare one owned tree's kill without giving up ownership. A survivor
 *  handle can thereby cancel the same lifecycle that originally spawned it. */
export function prepareOwnedShellTreeKill(jobId) {
  const entry = ownedTrees.get(String(jobId || '').trim())?.entry;
  if (!entry) return true;
  try {
    return entry.prepareKill();
  } catch {
    return false;
  }
}

/** Prepare the kill of every registered tree — of one owner, or of all when
 *  `ownerSessionId` is null (runtime shutdown). Its lifecycle owner unregisters
 *  it after the whole tree ends, so another cancel can still reach survivors.
 *  Returns the snapshots still pending (empty when all were complete). */
export function prepareOwnedShellTreeKills(ownerSessionId = null) {
  const owner = ownerSessionId == null ? null : String(ownerSessionId).trim();
  const pending = [];
  for (const [jobId, { entry }] of [...ownedTrees]) {
    if (owner !== null && String(entry.ownerSessionId || '') !== owner) continue;
    const ready = prepareOwnedShellTreeKill(jobId);
    if (ready !== true) pending.push(Promise.resolve(ready).catch(() => false));
  }
  return pending;
}

/** Cancel every tree of one owner and wait, bounded, for its lifecycle owners
 *  to confirm termination. Delivering a native cancel is not that proof. */
export function cancelOwnedShellTrees(ownerSessionId) {
  const owner = String(ownerSessionId || '').trim();
  const registered = [...ownedTrees].filter(([, { entry }]) => String(entry.ownerSessionId || '') === owner);
  const pending = prepareOwnedShellTreeKills(owner);
  const confirm = async (result) => {
    await withinBound(Promise.all(registered.map(([, record]) => record.terminated)), OWNER_CONFIRM_MS, false);
    const remaining = registered.filter(([id, record]) => ownedTrees.get(id) === record).map(([id]) => id);
    const unconfirmed = [...new Set([...(result.unconfirmed || []), ...remaining])];
    return {
      ...result,
      cancelled: Math.max(result.cancelled || 0, registered.length),
      unconfirmed,
      confirmed: unconfirmed.length === 0,
    };
  };
  const cancel = () => {
    const result = cancelNativeTasks({ ownerSessionId: owner });
    return registered.length ? confirm(result) : result;
  };
  if (pending.length === 0) return cancel();
  let result = null;
  const send = () => {
    if (pendingCancels.get(owner) === send) pendingCancels.delete(owner);
    result = result ?? cancel();
    return result;
  };
  pendingCancels.set(owner, send);
  return killAfterSnapshot(Promise.all(pending), send);
}

/** Send every owner cancel still waiting for its snapshot, now (runtime
 *  shutdown). A snapshot that has not landed leaves that outcome unknown. */
export function flushPendingOwnerCancels() {
  let sent = 0;
  for (const send of [...pendingCancels.values()]) {
    send();
    sent += 1;
  }
  return sent;
}
