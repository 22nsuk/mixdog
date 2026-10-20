import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { admitWorkspaceActivity, holdWorkspaceActivity, tryAdmitWorkspaceActivity } from './activity-gate.mjs';
import { admitTurn, retainAdmittedTurnWorkspace } from '../../../session-runtime/workspace/admission-gate.mjs';
import {
  completeShellJobRecord,
  publishShellJobRecord,
} from '../../agent/orchestrator/tools/builtin/lib/shell-job-records.mjs';
import { cleanupTempDirs, git, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';
import { withFileLockSync } from '../atomic-file.mjs';
import { putRecord, registryPath } from './registry.mjs';
import { samePath } from './paths.mjs';
import { spawnShellChild } from '../../agent/orchestrator/tools/lib/shell-run-spawn.mjs';

beforeEach(useTempDataDir);
after(cleanupTempDirs);
const moduleUrl = new URL('./activity-gate.mjs', import.meta.url).href;

function reader(t, repo, waiting = false, command = false, env = {}) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { tryAdmitWorkspaceActivity, admitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
    const cwd = process.argv[1];
    let leave = tryAdmitWorkspaceActivity('child', cwd, { kind: ${JSON.stringify(command ? 'command' : 'turn')} });
    if (!leave) {
      process.send('blocked');
      if (${waiting}) leave = await admitWorkspaceActivity('child', cwd);
      else process.exit(0);
    }
    process.send('active');
    process.on('message', () => { leave(); process.exit(0); });
  `,
      repo,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MIXDOG_DATA_DIR: tempDir(), ...env } }
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    child.kill();
    await exited;
  });
  return child;
}

test('same-folder readers remain parallel across processes and prevent a writer', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const leave = tryAdmitWorkspaceActivity('parent', repo);
  const child = reader(t, repo);
  assert.equal((await once(child, 'message'))[0], 'active');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  leave();
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
  holdWorkspaceActivity([repo])();
});

test('a published writer excludes a later foreign reader until release', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const release = holdWorkspaceActivity([repo]);
  const child = reader(t, repo, true);
  assert.equal((await once(child, 'message'))[0], 'blocked');
  const active = once(child, 'message');
  release();
  assert.equal((await active)[0], 'active');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
});

test('only a proven-dead reader is reclaimed, and an ownerless mutex is not reclaimed', {
  timeout: 20000,
}, async (t) => {
  const repo = makeRepo();
  const child = reader(t, repo);
  assert.equal((await once(child, 'message'))[0], 'active');
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  holdWorkspaceActivity([repo])();
  const lock = join(repo, '.git', 'ownerless.lock');
  writeFileSync(lock, 'corrupt');
  assert.throws(() =>
    withFileLockSync(lock, () => assert.fail('must not enter'), {
      strictOwner: true,
      timeoutMs: 0,
      staleMs: 0,
    })
  );
  assert.equal(existsSync(lock), true);
});

test('a command lease whose pid is proven dead no longer blocks after a restart', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const child = reader(t, repo, false, true);
  assert.equal((await once(child, 'message'))[0], 'active');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  holdWorkspaceActivity([repo])();
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), 'utf8')).leases, []);
});

test('only a dead command lease is reclaimed; a live one keeps the folder reserved', () => {
  const repo = makeRepo();
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const stale = tryAdmitWorkspaceActivity('restarted', repo, { kind: 'command', pid: deadPid });
  const live = tryAdmitWorkspaceActivity('running', repo, { kind: 'command' });
  assert.throws(
    () => holdWorkspaceActivity([repo]),
    (error) => error.code === 'WORKTREE_BUSY_JOBS' && error.details.reason === 'folder-in-use'
  );
  live();
  holdWorkspaceActivity([repo])();
  stale();
});

test('a provisioning turn protects its destination before moving, and releases both roots', async () => {
  const repo = makeRepo();
  const target = join(tempDir(), 'linked');
  git(repo, 'worktree', 'add', '-b', 'feature/next', target);
  // A Mixdog-created destination: only those are ever lock-blocked.
  await putRecord({ id: 'next', path: target });
  let cwd = repo;
  const leave = await admitTurn({ sessionId: 'moving', cwd: () => cwd });
  const writer = holdWorkspaceActivity([target]);
  assert.throws(() => retainAdmittedTurnWorkspace('moving', target), { code: 'WORKTREE_BUSY_JOBS' });
  assert.equal(cwd, repo);
  writer();
  retainAdmittedTurnWorkspace('moving', target);
  cwd = target;
  assert.throws(() => holdWorkspaceActivity([target]), { code: 'WORKTREE_BUSY_JOBS' });
  leave();
  holdWorkspaceActivity([repo, target])();
});

for (const nested of [false, true]) {
  test(`an external checkout ${nested ? 'inside' : 'outside'} the main checkout is never held, yet its running reader still refuses a writer`, () => {
    const repo = makeRepo();
    const external = join(nested ? repo : tempDir(), 'external');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/external', external);
    const writer = holdWorkspaceActivity([repo, external]);
    const reader = tryAdmitWorkspaceActivity('external-turn', external);
    try {
      assert.ok(reader, 'the external folder admits new work');
      assert.equal(tryAdmitWorkspaceActivity('project-turn', repo), null, 'the project folder waits');
    } finally {
      writer();
    }
    try {
      assert.throws(
        () => holdWorkspaceActivity([repo, external]),
        (error) => error.code === 'WORKTREE_BUSY_JOBS' && error.details.reason === 'folder-in-use'
      );
    } finally {
      reader?.();
    }
    holdWorkspaceActivity([repo, external])();
  });
}

for (const backup of [false, true]) {
  test(`registry damage ${backup ? 'with an older backup' : 'without a backup'} cannot hide management of a managed checkout`, async () => {
    const repo = makeRepo();
    const target = join(tempDir(), 'managed');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/managed', target);
    if (backup) await putRecord({ id: 'unrelated', path: join(tempDir(), 'unrelated') });
    await putRecord({ id: 'managed', path: target });
    const release = holdWorkspaceActivity([target]);
    let admitted;
    try {
      assert.equal(tryAdmitWorkspaceActivity('before-damage', target), null);
      writeFileSync(registryPath(), Buffer.alloc(64));
      admitted = tryAdmitWorkspaceActivity('after-damage', target);
      assert.equal(admitted, null, 'registry recovery cannot admit work over a live management lease');
    } finally {
      admitted?.();
      release();
    }
    const leave = tryAdmitWorkspaceActivity('after-release', target);
    assert.ok(leave, 'readers resume after management releases the checkout');
    leave();
  });
}

test('a profile without the registry entry still honors management of that checkout', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const target = join(tempDir(), 'managed');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/managed', target);
  await putRecord({ id: 'managed', path: target });
  const release = holdWorkspaceActivity([target]);
  try {
    const child = reader(t, target);
    const exited = once(child, 'exit');
    assert.equal((await once(child, 'message'))[0], 'blocked');
    await exited;
  } finally {
    release();
  }
});

test('a background command retains admission after its parent turn finishes', async () => {
  const repo = makeRepo();
  const leave = await admitWorkspaceActivity('parent', repo);
  publishShellJobRecord({ jobId: 'job_workspace_handoff', cwd: repo, pid: process.pid }, { ownerSessionId: 'parent' });
  leave();
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  await completeShellJobRecord('job_workspace_handoff', { status: 'completed', cwd: repo, exitCode: 0 });
  holdWorkspaceActivity([repo])();
});

test('a shell targeting a different checkout waits before spawning and cancels without creating a child', async () => {
  const repo = makeRepo();
  const release = holdWorkspaceActivity([repo]);
  const controller = new AbortController();
  const run = { foregroundRecordId: 'job_before_spawn' };
  const pending = spawnShellChild({
    run,
    cwd: repo,
    shell: process.execPath,
    directArgv: ['-e', 'process.exit(0)'],
    command: 'node',
    abortSignal: controller.signal,
    ownerSessionId: 'different-workspace',
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(run.child, undefined);
  release();
  holdWorkspaceActivity([repo])();
});

test('cancellation while waiting registers nothing', async () => {
  const repo = makeRepo();
  const writer = holdWorkspaceActivity([repo]);
  const controller = new AbortController();
  const pending = admitWorkspaceActivity('cancelled', repo, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  writer();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).leases, []);
  holdWorkspaceActivity([repo])();
});

const asideCopies = (repo) =>
  readdirSync(join(repo, '.git'))
    .filter((name) => name.startsWith('mixdog-workspace-admission.json.corrupt-'))
    .map((name) => join(repo, '.git', name));

const RECOVERY_MS = 400;
async function withShortRecovery(run) {
  const saved = [process.env.MIXDOG_ADMISSION_RECOVERY_MS, process.env.MIXDOG_ADMISSION_HEAL_MS];
  process.env.MIXDOG_ADMISSION_RECOVERY_MS = String(RECOVERY_MS);
  process.env.MIXDOG_ADMISSION_HEAL_MS = '100';
  try {
    await run();
  } finally {
    const [recovery, heal] = saved;
    if (recovery === undefined) delete process.env.MIXDOG_ADMISSION_RECOVERY_MS;
    else process.env.MIXDOG_ADMISSION_RECOVERY_MS = recovery;
    if (heal === undefined) delete process.env.MIXDOG_ADMISSION_HEAL_MS;
    else process.env.MIXDOG_ADMISSION_HEAL_MS = heal;
  }
}
const ledgerOf = (repo) => JSON.parse(readFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), 'utf8'));

function assertManagementBusy(repo, message) {
  let release;
  try {
    assert.throws(
      () => {
        release = holdWorkspaceActivity([repo]);
      },
      { code: 'WORKTREE_BUSY_JOBS' },
      message
    );
  } finally {
    release?.();
  }
}

function withFailedRename(path, run) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (samePath(to, path)) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    return rename(from, to, ...args);
  };
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
}

for (const missing of [false, true]) {
  test(`repeated management refusals preserve a foreign reader after ledger ${missing ? 'removal' : 'damage'}`, { timeout: 20000 }, async (t) => {
    const repo = makeRepo();
    const child = reader(t, repo, false, false, { MIXDOG_ADMISSION_HEAL_MS: '600000' });
    assert.equal((await once(child, 'message'))[0], 'active');
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    if (missing) unlinkSync(path);
    else writeFileSync(path, Buffer.alloc(64));
    assertManagementBusy(repo, 'the first management attempt refuses during recovery');
    assertManagementBusy(repo, 'an immediate retry cannot forget the live foreign reader');
    assert.equal(child.exitCode, null);
    const exited = once(child, 'exit');
    child.send('release');
    await exited;
    holdWorkspaceActivity([repo])();
  });
}

for (const command of [false, true]) {
  test(`recovery does not expire a delayed live ${command ? 'command' : 'turn'} holder`, { timeout: 20000 }, async (t) => {
    await withShortRecovery(async () => {
      const repo = makeRepo();
      const child = reader(t, repo, false, command, { MIXDOG_ADMISSION_HEAL_MS: '600000' });
      assert.equal((await once(child, 'message'))[0], 'active');
      writeFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), Buffer.alloc(64));
      const leave = tryAdmitWorkspaceActivity('later-reader', repo);
      assert.ok(leave, 'readers continue while the ledger recovers');
      leave();
      // The foreign holder has not healed. Advance only this process's clock
      // past the recovery window; elapsed time is not evidence of release.
      const now = Date.now.bind(Date);
      t.mock.method(Date, 'now', () => now() + RECOVERY_MS + 100);
      process.kill(child.pid, 0);
      assertManagementBusy(repo, 'elapsed recovery time cannot prove that a live holder released its lease');
      const exited = once(child, 'exit');
      if (command) child.kill();
      else child.send('release');
      await exited;
      holdWorkspaceActivity([repo])();
    });
  });
}

test('a damaged ledger is kept aside: readers continue, a live holder is never lost, management resumes by itself', async () => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    const leave = tryAdmitWorkspaceActivity('reader', repo);
    const intact = readFileSync(path);
    for (const damaged of [
      Buffer.alloc(intact.length),
      Buffer.from('{broken'),
      Buffer.alloc(0),
      Buffer.from('{"version":1,"leases":[null]}'),
    ]) {
      writeFileSync(path, damaged);
      const later = tryAdmitWorkspaceActivity('later-reader', repo);
      assert.ok(later, 'a damaged ledger admits readers');
      assert.ok(
        asideCopies(repo).some((copy) => readFileSync(copy).equals(damaged)),
        'the damaged bytes are kept aside, not overwritten'
      );
      later();
      // Recovery preserves the live holder, so management still refuses on it.
      assert.throws(() => holdWorkspaceActivity([repo]), {
        code: 'WORKTREE_BUSY_JOBS',
        details: { reason: 'folder-in-use' },
      });

      // A fresh profile meets the same damage: its reader continues, its writer waits.
      writeFileSync(path, damaged);
      const next = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import assert from 'node:assert/strict';
            import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
            const cwd = process.argv[1];
            tryAdmitWorkspaceActivity('new-process', cwd)();
            assert.throws(() => holdWorkspaceActivity([cwd]), { details: { reason: 'folder-in-use' } });
          `,
          repo,
        ],
        { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
      );
      assert.equal(next.error, undefined);
      assert.equal(next.status, 0, next.stderr);
      for (const copy of asideCopies(repo)) unlinkSync(copy);
    }
    leave();
    holdWorkspaceActivity([repo])();
    assert.deepEqual(ledgerOf(repo).leases, []);
    assert.equal(ledgerOf(repo).recoveredAt, undefined, 'complete recovery needs no unknown-lease delay');
  });
});

test('damage without recovery evidence admits readers but keeps management refused across retries and elapsed time', (t) => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), Buffer.alloc(64));
  assertManagementBusy(repo, 'the first refusal must retain the unresolved recovery state');
  assertManagementBusy(repo, 'retrying cannot turn lost ownership evidence into an empty workspace');
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  assert.ok(leave, 'readers can continue while earlier ownership is unknown');
  leave();
  const now = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => now() + 24 * 60 * 60 * 1000);
  assert.throws(() => holdWorkspaceActivity([repo]), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  assertManagementBusy(repo, 'elapsed time and repeated refusals cannot clear unknown ownership');
});

for (const [name, primary, mirror] of [
  ['legacy management-only mirror', null, { version: 1, leases: [] }],
  ['full mirror with an invalid record', null, { version: 1, allLeases: true, leases: [null] }],
  ['old recovery timestamp', { version: 1, leases: [], recoveredAt: 1 }, { version: 1, allLeases: true, leases: [] }],
  ['invalid record and recovery timestamp', { version: 1, leases: [null], recoveredAt: 'bad' }, null],
  ['malformed recovery timestamp', { version: 1, leases: [], recoveredAt: 'bad' }, null],
  ['null recovery timestamp', { version: 1, leases: [], recoveredAt: null }, null],
]) {
  test(`${name} cannot become complete ownership evidence on retry`, (t) => {
    const repo = makeRepo();
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    writeFileSync(path, primary ? JSON.stringify(primary) : Buffer.alloc(64));
    if (mirror) writeFileSync(`${path}.management`, JSON.stringify(mirror));
    const leave = tryAdmitWorkspaceActivity('reader', repo);
    assert.ok(leave, 'uncertain ownership still permits readers');
    leave();
    assertManagementBusy(repo, 'rewriting the mirror cannot resolve uncertain ownership');
    const now = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => now() + 24 * 60 * 60 * 1000);
    assertManagementBusy(repo, 'elapsed time cannot resolve uncertain ownership');
    unlinkSync(path);
    assertManagementBusy(repo, 'recovering from the rewritten mirror must retain uncertainty');
  });
}

test('a damaged ledger cannot hide a foreign management operation from readers', { timeout: 20000 }, async (t) => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
          const release = holdWorkspaceActivity([process.argv[1]]);
          process.on('message', () => { release(); process.exit(0); });
          process.send('active');
        `,
        repo,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // No self-heal in the holder: only the management mirror can restore its lease.
        env: { ...process.env, MIXDOG_DATA_DIR: tempDir(), MIXDOG_ADMISSION_HEAL_MS: '600000' },
      }
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    assert.equal((await once(child, 'message'))[0], 'active');
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    writeFileSync(path, Buffer.alloc(readFileSync(path).length));
    assert.equal(tryAdmitWorkspaceActivity('reader', repo), null, 'the operation in progress still excludes readers');
    const exited = once(child, 'exit');
    child.send('release');
    await exited;
    const leave = tryAdmitWorkspaceActivity('reader', repo);
    assert.ok(leave, 'readers resume once the operation ended');
    leave();
  });
});

test('a ledger of a newer build is left in place: readers go unrecorded, management refuses', () => {
  const repo = makeRepo();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  const newer = '{"version":2,"leases":[],"future":true}';
  writeFileSync(path, newer);
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  assert.ok(leave, 'prompts are never blocked by it');
  leave();
  assert.throws(() => holdWorkspaceActivity([repo]), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  assert.equal(readFileSync(path, 'utf8'), newer);
  assert.deepEqual(asideCopies(repo), []);
});

test('one invalid lease record is dropped without discarding the valid leases', { timeout: 20000 }, async (t) => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const child = reader(t, repo);
    assert.equal((await once(child, 'message'))[0], 'active');
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    ledger.leases.push({ kind: 'turn', token: 7 });
    writeFileSync(path, JSON.stringify(ledger));
    const leave = tryAdmitWorkspaceActivity('parent', repo);
    assert.ok(leave);
    assert.ok(
      ledgerOf(repo).leases.some((lease) => lease.pid === child.pid),
      'the valid foreign lease survived'
    );
    assert.ok(asideCopies(repo).some((copy) => JSON.parse(readFileSync(copy, 'utf8')).leases.length === 2));
    leave();
    assert.throws(() => holdWorkspaceActivity([repo]), {
      code: 'WORKTREE_BUSY_JOBS',
      details: { reason: 'folder-in-use' },
    });
    const exited = once(child, 'exit');
    child.send('release');
    await exited;
    holdWorkspaceActivity([repo])();
  });
});

test('an unreadable ledger is not overwritten and admission resumes after access is restored', () => {
  const repo = makeRepo();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  holdWorkspaceActivity([repo])();
  unlinkSync(path);
  mkdirSync(path);
  assert.throws(() => tryAdmitWorkspaceActivity('blocked', repo), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  assert.throws(() => holdWorkspaceActivity([repo]), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  rmdirSync(path);
  holdWorkspaceActivity([repo])();
});

test('a failed recovery-mirror write cannot grant new activity', () => {
  const repo = makeRepo();
  holdWorkspaceActivity([repo])();
  const mirror = join(repo, '.git', 'mixdog-workspace-admission.json.management');
  let unexpectedRelease;
  try {
    withFailedRename(mirror, () => {
      assert.throws(
        () => {
          unexpectedRelease = tryAdmitWorkspaceActivity('unrecorded-reader', repo);
        },
        { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } }
      );
      assert.throws(
        () => {
          unexpectedRelease = holdWorkspaceActivity([repo]);
        },
        { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } }
      );
    });
  } finally {
    unexpectedRelease?.();
  }
  holdWorkspaceActivity([repo])();
});

test('a failed primary grant is retracted from the recovery mirror', () => {
  for (const kind of ['turn', 'management']) {
    const repo = makeRepo();
    holdWorkspaceActivity([repo])();
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    let unexpectedRelease;
    try {
      withFailedRename(path, () => {
        assert.throws(
          () => {
            unexpectedRelease = kind === 'turn'
              ? tryAdmitWorkspaceActivity('failed-primary-grant', repo)
              : holdWorkspaceActivity([repo]);
          },
          { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } }
        );
      });
    } finally {
      unexpectedRelease?.();
    }
    writeFileSync(path, Buffer.alloc(64));
    holdWorkspaceActivity([repo])();
  }
});

for (const failedCopy of ['primary', 'mirror']) {
  for (const recovery of ['timer', 'mutation', 'missing ledger']) {
    test(`a failed ${failedCopy} management release is completed by ${recovery} without its handle`, (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const repo = makeRepo();
      const release = holdWorkspaceActivity([repo]);
      t.after(release);
      const path = join(repo, '.git', 'mixdog-workspace-admission.json');
      const mirror = `${path}.management`;
      withFailedRename(failedCopy === 'primary' ? path : mirror, () => {
        assert.throws(release, {
          code: 'WORKTREE_BUSY_JOBS',
          details: { reason: 'workspace-admission-unreadable' },
        });
        assert.equal(ledgerOf(repo).leases.length, failedCopy === 'primary' ? 1 : 0);
        assert.equal(JSON.parse(readFileSync(mirror, 'utf8')).leases.length, 1);
        // Another failed repair must retain the release intent, not ownership.
        t.mock.timers.tick(2000);
      });

      if (recovery === 'timer') {
        t.mock.timers.tick(2000);
        assert.deepEqual(ledgerOf(repo).leases, [], 'the timer finishes release without another caller');
        assert.deepEqual(JSON.parse(readFileSync(mirror, 'utf8')).leases, []);
      } else if (recovery === 'missing ledger') {
        unlinkSync(path);
      }
      const leave = tryAdmitWorkspaceActivity('after-failed-release', repo);
      try {
        assert.ok(leave, 'the completed management lease must not be republished');
        assert.equal(ledgerOf(repo).leases.some((lease) => lease.kind === 'management'), false);
      } finally {
        leave?.();
      }
      holdWorkspaceActivity([repo])();
    });
  }
}

for (const failedCopy of ['primary', 'mirror']) {
  test(`pending release recovery does not publish a new reader after its ${failedCopy} grant fails`, (t) => {
    const repo = makeRepo();
    const release = holdWorkspaceActivity([repo]);
    t.after(release);
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    const mirror = `${path}.management`;
    withFailedRename(mirror, () => assert.throws(release, { code: 'WORKTREE_BUSY_JOBS' }));
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, 'renameSync', (from, to, ...args) => {
      if (
        samePath(to, failedCopy === 'primary' ? path : mirror) &&
        JSON.parse(readFileSync(from, 'utf8')).leases.some((lease) => lease.sessionId === 'failed-grant')
      ) {
        throw Object.assign(new Error('injected grant failure'), { code: 'EIO' });
      }
      return rename(from, to, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => tryAdmitWorkspaceActivity('failed-grant', repo), {
        code: 'WORKTREE_BUSY_JOBS',
        details: { reason: 'workspace-admission-unreadable' },
      });
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(ledgerOf(repo).leases, [], 'neither a completed hold nor an ungranted reader survives');
    assert.deepEqual(JSON.parse(readFileSync(mirror, 'utf8')).leases, []);
    holdWorkspaceActivity([repo])();
  });
}

for (const kind of ['turn', 'command']) {
  test(`automatic release recovery removes only the completed ${kind} and preserves a live reader`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const repo = makeRepo();
    const leave = tryAdmitWorkspaceActivity('completed', repo, { kind });
    const live = tryAdmitWorkspaceActivity('still-running', repo);
    t.after(() => {
      leave();
      live();
    });
    const mirror = join(repo, '.git', 'mixdog-workspace-admission.json.management');
    withFailedRename(mirror, () => assert.throws(leave, { code: 'WORKTREE_BUSY_JOBS' }));
    t.mock.timers.tick(2000);
    for (const state of [ledgerOf(repo), JSON.parse(readFileSync(mirror, 'utf8'))]) {
      assert.deepEqual(state.leases.map((lease) => lease.sessionId), ['still-running']);
    }
    assertManagementBusy(repo, 'a pending release cannot remove another live lease');
    live();
    holdWorkspaceActivity([repo])();
  });
}

test('a release can retry a failed mirror write without leaving stale ownership', () => {
  const repo = makeRepo();
  holdWorkspaceActivity([repo])();
  const leave = tryAdmitWorkspaceActivity('retry-release', repo);
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  const mirror = `${path}.management`;
  try {
    withFailedRename(mirror, () => {
      assert.throws(leave, {
        code: 'WORKTREE_BUSY_JOBS',
        details: { reason: 'workspace-admission-unreadable' },
      });
    });
    const next = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
         holdWorkspaceActivity([process.argv[1]])();`,
        repo,
      ],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
    );
    assert.equal(next.error, undefined);
    assert.equal(next.status, 0, 'a healthy primary takes precedence over a stale mirror: ' + next.stderr);
  } finally {
    leave();
  }
  writeFileSync(path, Buffer.alloc(64));
  holdWorkspaceActivity([repo])();
});
