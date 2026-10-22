import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from './activity-gate.mjs';
import { samePath } from './paths.mjs';
import { cleanupTempDirs, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';

beforeEach(useTempDataDir);
after(cleanupTempDirs);

const moduleUrl = new URL('./activity-gate.mjs', import.meta.url).href;
const ledgerPath = (repo) => join(repo, '.git', 'mixdog-workspace-admission.json');
const copies = (repo) => [ledgerPath(repo), `${ledgerPath(repo)}.management`];
const states = (repo) => copies(repo).map((path) => JSON.parse(readFileSync(path, 'utf8')));
const unreadable = { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } };

function foldersIn(repo) {
  return ['first', 'second'].map((name) => {
    const folder = join(repo, name);
    mkdirSync(folder);
    return folder;
  });
}

function patchRename(t, fails) {
  const original = fs.renameSync;
  let stopped = false;
  fs.renameSync = (from, to, ...args) => {
    if (fails(from, to)) throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    return original(from, to, ...args);
  };
  syncBuiltinESMExports();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    fs.renameSync = original;
    syncBuiltinESMExports();
  };
  t.after(stop);
  return stop;
}

// Allow the complete grant mirror, then fail the primary and every attempt
// to retract the grant from the mirror. Keep failures enabled during retries.
function failedGrant(repo, matches) {
  const [primary, mirror] = copies(repo);
  const tokens = new Set();
  const hits = { primary: 0, rollback: 0, published: 0 };
  return {
    tokens,
    hits,
    fails(from, to) {
      if (samePath(to, primary)) {
        hits.primary += 1;
        return true;
      }
      if (!samePath(to, mirror)) return false;
      const next = JSON.parse(readFileSync(from, 'utf8'));
      const offered = next.leases.filter(matches);
      if (!tokens.size && offered.length) {
        for (const lease of offered) tokens.add(lease.token);
        hits.published += 1;
        return false;
      }
      if (tokens.size && !next.leases.some((lease) => tokens.has(lease.token))) {
        hits.rollback += 1;
        return true;
      }
      return false;
    },
  };
}

function assertRetracted(repo, tokens) {
  for (const state of states(repo)) {
    assert.equal(
      state.leases.some((lease) => tokens.has(lease.token)),
      false,
      'ungranted tokens are removed'
    );
  }
}

function assertResumed(repo) {
  const leave = tryAdmitWorkspaceActivity('resumed-reader', repo);
  assert.ok(leave);
  leave();
  holdWorkspaceActivity([repo])();
  for (const state of states(repo)) assert.deepEqual(state.leases, []);
}

for (const kind of ['turn', 'command', 'management']) {
  for (const recovery of ['timer', 'mutation']) {
    test(`an unacquired first ${kind} grant is retracted by ${recovery} after failed primary and rollback writes`, (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const repo = makeRepo();
      const folders = foldersIn(repo);
      const fault = failedGrant(repo, (lease) =>
        kind === 'management' ? lease.kind === kind : lease.sessionId === 'ungranted'
      );
      const stop = patchRename(t, fault.fails);
      t.after(() => {
        stop();
        assertResumed(repo);
      });
      let handle;
      assert.throws(() => {
        handle =
          kind === 'management'
            ? holdWorkspaceActivity(folders)
            : tryAdmitWorkspaceActivity('ungranted', folders[0], { kind });
      }, unreadable);
      assert.equal(handle, undefined, 'admission never returned ownership to its caller');
      assert.equal(existsSync(ledgerPath(repo)), false, 'this is the first failed primary publication');
      assert.doesNotThrow(() => process.kill(process.pid, 0), 'the runtime remains alive');
      assert.equal(fault.hits.published, 1);
      assert.ok(fault.hits.primary > 0);
      assert.ok(fault.hits.rollback > 0);
      const saved = JSON.parse(readFileSync(copies(repo)[1], 'utf8'));
      assert.equal(saved.leases.length, kind === 'management' ? 2 : 1);
      assert.equal(fault.tokens.size, 1, 'all management paths share one token');

      const failedWrites = fault.hits.primary;
      t.mock.timers.tick(2000);
      assert.ok(fault.hits.primary > failedWrites, 'the timer retries while I/O is still broken');
      assert.throws(() => tryAdmitWorkspaceActivity('must-not-grant', folders[0]), unreadable);
      assert.equal(existsSync(ledgerPath(repo)), false);
      assert.equal(
        JSON.parse(readFileSync(copies(repo)[1], 'utf8')).leases.some((lease) => lease.sessionId === 'must-not-grant'),
        false
      );

      stop();
      if (recovery === 'timer') {
        t.mock.timers.tick(2000);
        assertRetracted(repo, fault.tokens);
        for (const state of states(repo)) assert.deepEqual(state.leases, []);
      } else {
        const leave = tryAdmitWorkspaceActivity('repairing-reader', folders[0]);
        assert.ok(leave, 'pending cleanup finishes before the new reader is evaluated');
        assertRetracted(repo, fault.tokens);
        leave();
      }
      assertResumed(repo);
    });
  }
}

async function foreignReader(t, cwd) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
    const leave = tryAdmitWorkspaceActivity('foreign-live', process.argv[1]);
    process.on('message', () => { leave(); process.exit(0); });
    process.send('active');
  `,
      cwd,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, MIXDOG_DATA_DIR: tempDir(), MIXDOG_ADMISSION_HEAL_MS: '600000' },
    }
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    child.kill();
    await exited;
  });
  assert.equal((await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0], 'active');
  return child;
}

for (const damage of ['missing', 'damaged']) {
  test(`failed grant cleanup preserves a foreign reader with a ${damage} primary`, { timeout: 20000 }, async (t) => {
    const repo = makeRepo();
    const [liveFolder, requestedFolder] = foldersIn(repo);
    const child = await foreignReader(t, liveFolder);
    const primary = ledgerPath(repo);
    if (damage === 'missing') unlinkSync(primary);
    else writeFileSync(primary, Buffer.from('{damaged'));
    const fault = failedGrant(repo, (lease) => lease.kind === 'management');
    const stop = patchRename(t, fault.fails);
    try {
      assert.throws(() => holdWorkspaceActivity([requestedFolder]), unreadable);
      assert.ok(fault.hits.primary > 0 && fault.hits.rollback > 0);
    } finally {
      stop();
    }
    const release = holdWorkspaceActivity([requestedFolder]);
    release();
    assertRetracted(repo, fault.tokens);
    for (const state of states(repo)) {
      assert.deepEqual(
        state.leases.map((lease) => lease.pid),
        [child.pid],
        'foreign ownership survives cleanup'
      );
      assert.equal(state.recoveredAt, undefined, 'the complete mirror still establishes ownership');
    }
    assert.throws(() => holdWorkspaceActivity([liveFolder]), { details: { reason: 'folder-in-use' } });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    child.send('release');
    await exited;
    assertResumed(repo);
  });
}

test('failed multi-repository grants retry cleanup for the failing group and an earlier hold whose unwind fails', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const [first, second] = [makeRepo(), makeRepo()].sort((a, b) => a.localeCompare(b));
  const fault = failedGrant(second, (lease) => lease.kind === 'management');
  let unwindFailures = 0;
  const stop = patchRename(t, (from, to) => {
    if (samePath(to, copies(first)[1]) && JSON.parse(readFileSync(from, 'utf8')).leases.length === 0) {
      unwindFailures += 1;
      return true;
    }
    return fault.fails(from, to);
  });
  t.after(() => {
    stop();
    holdWorkspaceActivity([first, second])();
  });
  let handle;
  assert.throws(() => {
    handle = holdWorkspaceActivity([first, second]);
  }, unreadable);
  assert.equal(handle, undefined);
  assert.ok(fault.hits.primary > 0 && fault.hits.rollback > 0 && unwindFailures > 0);
  assert.deepEqual(states(first)[0].leases, [], 'the earlier hold dropped from its primary before mirror failure');
  assert.equal(states(first)[1].leases.length, 1);
  t.mock.timers.tick(2000);
  stop();
  t.mock.timers.tick(2000);
  for (const repo of [first, second]) {
    for (const state of states(repo)) assert.deepEqual(state.leases, []);
    assertResumed(repo);
  }
});

for (const newerCopy of ['primary', 'mirror']) {
  test(`pending failed grants leave a newer ${newerCopy} untouched and retain cleanup intent`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const repo = makeRepo();
    const fault = failedGrant(repo, (lease) => lease.kind === 'management');
    const stop = patchRename(t, fault.fails);
    try {
      assert.throws(() => holdWorkspaceActivity([repo]), unreadable);
      assert.ok(fault.hits.primary > 0 && fault.hits.rollback > 0);
    } finally {
      stop();
    }
    const chosen = copies(repo)[newerCopy === 'primary' ? 0 : 1];
    const previous = existsSync(chosen) ? readFileSync(chosen) : null;
    const newer = '{"version":2,"leases":[],"future":"preserve bytes"}\n';
    writeFileSync(chosen, newer);
    let restored = false;
    const restore = () => {
      if (restored) return;
      if (previous === null) unlinkSync(chosen);
      else writeFileSync(chosen, previous);
      restored = true;
    };
    t.after(() => {
      restore();
      assertResumed(repo);
    });
    const before = copies(repo).map((path) => (existsSync(path) ? readFileSync(path) : null));
    t.mock.timers.tick(2000);
    const leave = tryAdmitWorkspaceActivity('newer-unrecorded', repo);
    assert.ok(leave);
    leave();
    assert.throws(() => holdWorkspaceActivity([repo]), unreadable);
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(existsSync(copies(repo)[index]) ? readFileSync(copies(repo)[index]) : null, before[index]);
    }
    restore();
    t.mock.timers.tick(2000);
    assertRetracted(repo, fault.tokens);
    assertResumed(repo);
  });
}

test('failed reader cleanup retains an existing unknown-ownership marker', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const repo = makeRepo();
  const state = { version: 1, leases: [], recoveredAt: 1 };
  writeFileSync(ledgerPath(repo), JSON.stringify(state));
  writeFileSync(copies(repo)[1], JSON.stringify({ ...state, allLeases: true }));
  const fault = failedGrant(repo, (lease) => lease.sessionId === 'ungranted');
  const stop = patchRename(t, fault.fails);
  try {
    assert.throws(() => tryAdmitWorkspaceActivity('ungranted', repo), unreadable);
    assert.ok(fault.hits.primary > 0 && fault.hits.rollback > 0);
  } finally {
    stop();
  }
  t.mock.timers.tick(2000);
  assertRetracted(repo, fault.tokens);
  for (const saved of states(repo)) {
    assert.deepEqual(saved.leases, []);
    assert.equal(saved.recoveredAt, 1);
  }
  assert.throws(() => holdWorkspaceActivity([repo]), unreadable);
});

test('a successful management grant remains exclusive through primary loss until its handle releases it', () => {
  const repo = makeRepo();
  const folders = foldersIn(repo);
  const release = holdWorkspaceActivity(folders);
  try {
    unlinkSync(ledgerPath(repo));
    assert.equal(tryAdmitWorkspaceActivity('blocked-by-valid-owner', folders[0]), null);
    for (const state of states(repo)) assert.equal(state.leases.length, 2);
  } finally {
    release();
  }
  assertResumed(repo);
});

test('a primary grant failure with successful mirror rollback leaves no unacquired owner', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const repo = makeRepo();
  let failures = 0;
  const stop = patchRename(t, (_from, to) => {
    if (!samePath(to, ledgerPath(repo))) return false;
    failures += 1;
    return true;
  });
  try {
    assert.throws(() => tryAdmitWorkspaceActivity('rollback-succeeds', repo), unreadable);
    assert.ok(failures > 0);
    assert.equal(existsSync(ledgerPath(repo)), false);
    assert.deepEqual(JSON.parse(readFileSync(copies(repo)[1], 'utf8')).leases, []);
  } finally {
    stop();
  }
  assertResumed(repo);
});
