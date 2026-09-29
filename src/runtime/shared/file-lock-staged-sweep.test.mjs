import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sweepStagedLockFiles } from './file-lock.mjs';

test('a stale staged owner record of a dead process is swept once per lock path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A pid that certainly exited: a child that already ran to completion.
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const lockPath = join(dir, 'store.json.lock');
  const old = new Date(Date.now() - 5 * 60_000);
  const file = (name, stale) => {
    const path = join(dir, name);
    writeFileSync(path, `${deadPid} 0 token\n`);
    if (stale) utimesSync(path, old, old);
    return path;
  };
  const deadStale = file(`store.json.lock.${deadPid}.0123456789abcdef.tmp`, true);
  const deadGuard = file(`store.json.lock.reclaim.${deadPid}.0123456789abcdef.tmp`, true);
  const deadFresh = file(`store.json.lock.${deadPid}.fedcba9876543210.tmp`, false);
  const liveStale = file(`store.json.lock.${process.pid}.0123456789abcdef.tmp`, true);
  const otherLock = file(`other.json.lock.${deadPid}.0123456789abcdef.tmp`, true);
  const unrelated = file('store.json.lock.backup.tmp', true);

  assert.equal(sweepStagedLockFiles(lockPath), 2);
  assert.equal(existsSync(deadStale), false);
  assert.equal(existsSync(deadGuard), false);
  for (const kept of [deadFresh, liveStale, otherLock, unrelated]) assert.equal(existsSync(kept), true);
  // Once per lock path per process: a later stale file waits for the next process.
  const later = file(`store.json.lock.${deadPid}.1111111111111111.tmp`, true);
  assert.equal(sweepStagedLockFiles(lockPath), 0);
  assert.equal(existsSync(later), true);
});
