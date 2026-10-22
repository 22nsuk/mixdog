import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, join } from 'node:path';
import {
  parseJsonText,
  quarantinePath,
  withFileLockSync,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} from '../atomic-file.mjs';
import { isPidAliveOrUnknown } from '../pid-liveness.mjs';
import { findGitLayout } from './git-head.mjs';
import { canonicalPath, isWithin, samePath } from './paths.mjs';
import { worktreeError, worktreeRefusal } from './contract.mjs';
import { readRegistrySync } from './registry.mjs';

const FILE = 'mixdog-workspace-admission.json';
const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

/**
 * The admission policy's external exception: a linked checkout Mixdog did not
 * create (not a project's main folder, not a registered managed worktree) is
 * not held by management. Its readers ignore holds on other checkouts; an
 * already published hold on this checkout still applies if registry recovery
 * or a different profile subsequently classifies the checkout as external.
 * Its running readers still refuse a management action that touches it.
 */
export function isExternalCheckout(folder) {
  const layout = findGitLayout(folder, { strict: true });
  if (!layout || samePath(layout.gitDir, layout.commonDir)) return false;
  let entries;
  try {
    entries = readRegistrySync().entries;
  } catch {
    // A damaged registry is kept aside and reads as a restored or empty one;
    // only a real I/O failure (access denied, in use) lands here.
    throw worktreeRefusal('workspace-admission-unreadable');
  }
  return !Object.values(entries).some(
    (record) => typeof record?.path === 'string' && samePath(record.path, layout.topLevel)
  );
}

const VERSION = 1;
const UNRECORDED = Symbol('unrecorded');
const emptyLedger = () => ({ version: VERSION, leases: [] });
const isNewer = (state) => Number.isSafeInteger(state?.version) && state.version > VERSION;
const isLease = (lease) =>
  !!lease &&
  ['turn', 'command', 'management'].includes(lease.kind) &&
  typeof lease.token === 'string' &&
  Number.isSafeInteger(lease.pid) &&
  lease.pid > 0 &&
  typeof lease.path === 'string' &&
  isAbsolute(lease.path);
const hasLedgerShape = (state) => state?.version === VERSION && Array.isArray(state.leases);
const hasUnknownLeases = (state) => Object.hasOwn(state ?? {}, 'recoveredAt');

const refuseUnreadable = () => {
  throw worktreeRefusal('workspace-admission-unreadable');
};
const envMs = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const healIntervalMs = () => envMs('MIXDOG_ADMISSION_HEAL_MS', 2_000);

// All reads, damage preservation and both writes run under the ledger's one
// lock. Copy damaged bytes before replacing them: moving the only copy aside
// would turn a failed recovery write into an apparently fresh workspace.
// Never restore an older .bak, which could resurrect leases long released.
function readSnapshot(path) {
  let content;
  try {
    content = readFileSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: null, content: null, damaged: false };
    return refuseUnreadable();
  }
  let state;
  try {
    state = parseJsonText(content.toString('utf8'));
  } catch {
    return { state: null, content, damaged: true };
  }
  const damaged = !isNewer(state) && (!hasLedgerShape(state) || !state.leases.every(isLease));
  return { state, content, damaged };
}

function keepAside(path, content) {
  const aside = quarantinePath(path);
  writeFileAtomicSync(aside, content);
  process.stderr.write(`[state] ${path} is damaged; kept as ${aside}\n`);
}

const aliveLease = (lease) => isPidAliveOrUnknown(lease.pid);

// Retain the existing side-file path so legacy management leases are still
// recoverable. allLeases describes its coverage, not whether ownership is
// known: recoveredAt survives in both copies until the unknown state is
// explicitly recovered. Time or a delayed holder's heartbeat proves nothing.
function writeMirror(mirror, state) {
  writeJsonAtomicSync(mirror, { ...state, allLeases: true }, { compact: true });
}

function writeState(path, mirror, before, next) {
  const remaining = new Set(next.leases.map(leaseKey));
  const releasing = before.leases.some((lease) => !remaining.has(leaseKey(lease)));
  if (releasing) {
    // A failed release remains pending for this process to retry. It must
    // never remove the recovery copy before the ledger drops the lease.
    writeJsonAtomicSync(path, next, { compact: true });
    writeMirror(mirror, next);
    return;
  }
  // Publish a recoverable grant before admitting its caller. If the ledger
  // write fails, retract the ungranted mirror entry while still holding the
  // lock. A failed rollback remains conservative; the intact ledger wins on
  // the next mutation and resynchronizes the mirror.
  writeMirror(mirror, next);
  try {
    writeJsonAtomicSync(path, next, { compact: true });
  } catch (error) {
    try {
      writeMirror(mirror, before);
    } catch {}
    throw error;
  }
}

// Live leases are republished if lost. A failed release stays here with
// releasing=true until both copies are cleared, even if its caller moves on.
const held = new Map();
let healTimer = null;

// A management hold shares one token across its folders, so a lease is
// identified by token and path.
const leaseKey = (lease) => `${lease.token}\0${lease.path}`;

function track(commonDir, lease) {
  held.set(leaseKey(lease), { commonDir, lease });
  healTimer ??= setInterval(healHeld, healIntervalMs());
  healTimer.unref?.();
}

function untrack(token) {
  for (const [key, { lease }] of held) if (lease.token === token) held.delete(key);
  if (!held.size && healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
}

function ledgerLacks(commonDir, keys) {
  let state;
  try {
    state = parseJsonText(readFileSync(join(commonDir, FILE), 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' || error instanceof SyntaxError;
  }
  if (isNewer(state)) return false;
  if (!hasLedgerShape(state)) return true;
  const stored = new Set(state.leases.filter(Boolean).map(leaseKey));
  return keys.some((key) => !stored.has(key));
}

function healHeld() {
  const byDir = new Map();
  for (const [key, { commonDir }] of held) byDir.set(commonDir, [...(byDir.get(commonDir) ?? []), key]);
  for (const [commonDir, keys] of byDir) {
    if (!keys.some((key) => held.get(key)?.releasing) && !ledgerLacks(commonDir, keys)) continue;
    try {
      mutate(
        commonDir,
        () => {},
        () => {}
      );
    } catch {
      // Retried on the next tick.
    }
  }
}

/**
 * Runs `update(leases, { unknown })` under the ledger lock. `unknown`: neither
 * copy can establish all ownership. It never expires on a timer. A complete
 * mirror restores live leases even if their holders cannot currently heal.
 * `onNewer` answers for a ledger of a newer build, which is left untouched:
 * it refuses by default; readers pass an answer that admits them unrecorded.
 */
function mutate(commonDir, update, onNewer = refuseUnreadable) {
  const path = join(commonDir, FILE);
  const mirror = `${path}.management`;
  return withFileLockSync(
    `${path}.lock`,
    () => {
      const current = readSnapshot(path);
      if (isNewer(current.state)) return onNewer();
      const saved = readSnapshot(mirror);
      if (isNewer(saved.state)) return onNewer();
      const recovering = current.damaged || current.content === null;
      const fullMirror = hasLedgerShape(saved.state) && !saved.damaged && saved.state.allLeases === true;
      let state = hasLedgerShape(current.state)
        ? { ...current.state, leases: current.state.leases.filter(isLease) }
        : emptyLedger();
      const restore = [
        ...(recovering && hasLedgerShape(saved.state) ? saved.state.leases.filter(isLease) : []),
        ...[...held.values()].filter((own) => own.commonDir === commonDir && !own.releasing).map((own) => own.lease),
      ];
      // An absent pair is a fresh workspace. An absent ledger with a mirror
      // is recovery, including a crash between the two durable writes.
      const unknown =
        hasUnknownLeases(state) ||
        (recovering && (hasUnknownLeases(saved.state) || (!fullMirror && (current.damaged || saved.content !== null))));
      if (unknown) {
        if (!Number.isFinite(state.recoveredAt)) state.recoveredAt = Date.now();
      } else delete state.recoveredAt;
      // Only a pid PROVEN dead (ESRCH) drops its lease, whatever its kind; an
      // unprobeable pid still counts as running. A live runtime keeps a command
      // whose tree it cannot verify reserved under its own (live) pid until the
      // tree is confirmed gone, so a lease that outlives every pid belongs to a
      // restarted runtime that can no longer release it.
      state.leases = state.leases.filter(aliveLease);
      const present = new Set(state.leases.map(leaseKey));
      for (const lease of restore) {
        if (present.has(leaseKey(lease)) || !aliveLease(lease)) continue;
        present.add(leaseKey(lease));
        state.leases.push(lease);
      }
      try {
        if (current.damaged) keepAside(path, current.content);
        if (saved.damaged) keepAside(mirror, saved.content);
        const releasing = new Set(
          [...held.values()].filter((own) => own.commonDir === commonDir && own.releasing).map((own) => own.lease.token)
        );
        if (releasing.size) {
          const released = { ...state, leases: state.leases.filter((lease) => !releasing.has(lease.token)) };
          // Finish pending releases before evaluating or publishing another
          // request. Combining a release with a new grant would use release
          // write ordering and could leave an ungranted lease on failure.
          writeState(path, mirror, state, released);
          state = released;
          for (const token of releasing) untrack(token);
        }
      } catch {
        return refuseUnreadable();
      }
      let next = { ...state, leases: [...state.leases] };
      let result;
      let refusal;
      try {
        result = update(next.leases, { unknown });
      } catch (error) {
        // Persist only the recovered ownership, never a partial request, even
        // when policy refuses. An immediate retry must see the same protection.
        refusal = error;
        next = state;
      }
      try {
        writeState(path, mirror, state, next);
      } catch {
        return refuseUnreadable();
      }
      if (refusal) throw refusal;
      return result;
    },
    { strictOwner: true }
  );
}

function release(commonDir, token) {
  let done = false;
  return () => {
    if (done) return;
    try {
      mutate(
        commonDir,
        (leases) => {
          for (let i = leases.length - 1; i >= 0; i--) if (leases[i].token === token) leases.splice(i, 1);
        },
        () => {}
      );
    } catch (error) {
      for (const own of held.values()) if (own.lease.token === token) own.releasing = true;
      throw error;
    }
    done = true;
    untrack(token);
  };
}

/**
 * Readers share a checkout freely. Null means a management writer currently
 * owns it. An external checkout ignores holds belonging to other checkouts.
 */
export function tryAdmitWorkspaceActivity(sessionId, cwd, { pid = process.pid, kind = 'turn' } = {}) {
  if (!['turn', 'command'].includes(kind)) throw new TypeError('Invalid workspace reader kind.');
  const layout = findGitLayout(cwd, { strict: true });
  if (!layout) return () => {};
  const external = isExternalCheckout(cwd);
  const path = canonicalPath(cwd);
  const token = randomUUID();
  const lease = { kind, sessionId, pid, token, path };
  const admitted = mutate(
    layout.commonDir,
    (leases) => {
      if (
        leases.some(
          (other) =>
            other.kind === 'management' &&
            overlaps(other.path, path) &&
            (!external || isWithin(layout.topLevel, other.path))
        )
      ) {
        return false;
      }
      leases.push(lease);
      return true;
    },
    // A newer build's ledger cannot be written: the reader goes unrecorded
    // (prompts never wait on it) while management refuses on it.
    () => UNRECORDED
  );
  if (admitted === UNRECORDED) return () => {};
  if (!admitted) return null;
  track(layout.commonDir, lease);
  return release(layout.commonDir, token);
}

export async function admitWorkspaceActivity(sessionId, cwd, signal, options) {
  for (;;) {
    signal?.throwIfAborted();
    const leave = tryAdmitWorkspaceActivity(sessionId, cwd, options);
    if (leave) {
      if (signal?.aborted) {
        finishWorkspaceActivity(leave);
        signal.throwIfAborted();
      }
      return leave;
    }
    await delay(100, undefined, { signal });
  }
}

/**
 * Writers refuse while any process's reader overlaps an affected folder, then
 * exclude later readers until the returned release is called. External
 * checkouts are only checked, never held. `sessionId`: the acting session,
 * whose own readers in this process do not count (its idleness is the
 * caller's check).
 */
export function holdWorkspaceActivity(folders, { sessionId = null } = {}) {
  const groups = new Map();
  for (const folder of folders) {
    const layout = findGitLayout(folder, { strict: true });
    if (!layout) throw worktreeError('WORKTREE_UNSUPPORTED_REPO');
    const paths = groups.get(layout.commonDir) ?? [];
    paths.push({ path: canonicalPath(folder), external: isExternalCheckout(folder) });
    groups.set(layout.commonDir, paths);
  }
  const releases = [];
  try {
    for (const [commonDir, paths] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const token = randomUUID();
      const taken = [];
      mutate(commonDir, (leases, { unknown }) => {
        const conflicts = leases.filter(
          (lease) =>
            !(sessionId && lease.sessionId === sessionId && lease.pid === process.pid) &&
            paths.some(({ path }) => overlaps(path, lease.path))
        );
        if (conflicts.length) throw worktreeRefusal('folder-in-use');
        // Unknown foreign ownership cannot be disproven by waiting: holders
        // may be paused or unable to run their heal timer.
        if (unknown) throw worktreeRefusal('workspace-admission-unreadable');
        for (const { path, external } of paths) {
          if (external) continue;
          const lease = { kind: 'management', pid: process.pid, token, path };
          leases.push(lease);
          taken.push(lease);
        }
      });
      for (const lease of taken) track(commonDir, lease);
      releases.push(release(commonDir, token));
    }
  } catch (error) {
    finishWorkspaceActivity(...releases);
    throw error;
  }
  return () => releaseAll(releases);
}

/** Runs every release in reverse order even when one throws; the first failure is rethrown after all ran. */
export function releaseAll(releases) {
  let failure = null;
  for (const done of [...releases].reverse()) {
    try {
      done();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/**
 * Finish ownership after work settled (or was handed to an admitted owner).
 * Attempt every handle: release() records failed persistence for heal/mutate
 * to retry. Cleanup must not replace the operation's result/error or prevent
 * later cleanup. Return the failure for surfaces that display pending cleanup;
 * admission/grant failures still throw, as does the low-level release handle.
 */
export function finishWorkspaceActivity(...releases) {
  try {
    releaseAll(releases.filter((leave) => leave != null));
    return null;
  } catch (error) {
    try {
      process.stderr.write(`[workspace-admission] release pending code=${error?.code || 'unknown'}\n`);
    } catch {
      /* diagnostics must not interrupt settlement */
    }
    return error;
  }
}
