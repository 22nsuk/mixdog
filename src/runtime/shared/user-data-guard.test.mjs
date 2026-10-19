import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { withFileLockSync } from './atomic-file.mjs';
import { readConfig, updateConfig, updateSection, updateSectionAsync } from './config.mjs';
import {
  backupUserData,
  backupUserDataAsync,
  hasUserDataInitMarker,
  loadLatestMixdogConfigFromBackup,
  markUserDataInitialized,
} from './user-data-guard.mjs';

process.env.MIXDOG_SETUP_QUIET = '1';
delete process.env.MIXDOG_SKIP_USER_DATA_BACKUP;

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-user-data-guard-'));
  const saved = {
    MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    MIXDOG_USER_DATA_BACKUP_ROOT: process.env.MIXDOG_USER_DATA_BACKUP_ROOT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const backupRoot = join(root, 'backups');
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
  const dir = (name) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const scopes = () => readdirSync(backupRoot).filter((name) => name.startsWith('scope-'));
  return { backupRoot, dir, scopes };
}

const use = (dataDir) => {
  process.env.MIXDOG_DATA_DIR = dataDir;
};
const configFile = (dataDir) => join(dataDir, 'mixdog-config.json');
const complete = (tag) => ({ agent: { tag }, ui: { theme: tag } });
const write = (tag) => updateConfig(() => complete(tag));
const tag = () => readConfig().agent?.tag;

function writeLegacyBackup(backupRoot, name, config, manifest) {
  const dir = join(backupRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mixdog-config.json'), JSON.stringify(config));
  if (manifest) writeFileSync(join(dir, 'backup.json'), JSON.stringify(manifest));
  return dir;
}

test('two data dirs sharing a backup root never restore each other', async (t) => {
  const { dir, scopes, backupRoot } = sandbox(t);
  const a = dir('a');
  const b = dir('b');
  use(b);
  write('B');
  use(a);
  write('A'); // newest backup in the shared root
  assert.equal(scopes().length, 2);
  for (const scope of scopes()) {
    for (const backup of readdirSync(join(backupRoot, scope))) {
      const manifest = JSON.parse(readFileSync(join(backupRoot, scope, backup, 'backup.json'), 'utf8'));
      assert.ok([resolve(a), resolve(b)].includes(manifest.dataDir));
      assert.equal(typeof manifest.instanceId, 'string');
    }
  }
  const asyncBackup = await backupUserDataAsync(a, 'async');
  assert.equal(JSON.parse(readFileSync(join(asyncBackup.dir, 'backup.json'), 'utf8')).dataDir, resolve(a));

  use(b);
  rmSync(configFile(b));
  assert.equal(tag(), 'B');

  // An initialized data dir with no backups of its own restores nothing.
  const c = dir('c');
  markUserDataInitialized(c);
  use(c);
  assert.equal(loadLatestMixdogConfigFromBackup(c), null);
  assert.deepEqual(readConfig(), {});
});

test('a recreated profile at the same path is fresh, never a restore case', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  use(a);
  write('old');
  rmSync(a, { recursive: true, force: true });
  mkdirSync(a);
  assert.equal(hasUserDataInitMarker(a), false);
  assert.deepEqual(readConfig(), {});
  updateSection('ui', { theme: 'new' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent, undefined);
  assert.equal(stored.ui.theme, 'new');

  // Even once the new incarnation is initialized, the old one's backups in the
  // same scope are not its own.
  const b = dir('b');
  use(b);
  write('old-b');
  assert.equal(loadLatestMixdogConfigFromBackup(b).agent.tag, 'old-b');
  rmSync(b, { recursive: true, force: true });
  mkdirSync(b);
  markUserDataInitialized(b);
  assert.equal(loadLatestMixdogConfigFromBackup(b), null);
  assert.deepEqual(readConfig(), {});
});

test('pruning keeps N backups per scope and never evicts another scope or legacy entries', (t) => {
  const { dir, backupRoot } = sandbox(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const installed = dir('installed');
  const dev = dir('dev');
  writeFileSync(configFile(installed), JSON.stringify(complete('installed')));
  writeFileSync(configFile(dev), JSON.stringify(complete('dev')));
  const legacy = writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-legacy', complete('legacy'));
  const installedDirs = [1, 2, 3].map((i) => backupUserData(installed, `installed-${i}`).dir);
  const devDirs = Array.from({ length: 45 }, (_, i) => backupUserData(dev, `dev-${String(i).padStart(2, '0')}`).dir);
  for (const path of installedDirs) assert.equal(existsSync(path), true, path);
  assert.equal(existsSync(legacy), true);
  assert.equal(readdirSync(join(devDirs[0], '..')).length, 40);
  assert.equal(
    devDirs.slice(5).every((path) => existsSync(path)),
    true
  );
});

test('legacy unscoped backups are ignored unless their manifest matches this data dir', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  writeFileSync(configFile(a), JSON.stringify(complete('a')));
  const instanceId = markUserDataInitialized(a);
  // Newest first: three non-matching entries shadow one matching entry.
  const entries = [
    writeLegacyBackup(backupRoot, '2020-01-04T00-00-00-000Z-none', complete('none')),
    writeLegacyBackup(backupRoot, '2020-01-03T00-00-00-000Z-other', complete('other'), {
      dataDir: dir('other'),
      instanceId,
    }),
    writeLegacyBackup(backupRoot, '2020-01-02T00-00-00-000Z-stale', complete('stale'), {
      dataDir: a,
      instanceId: 'previous-incarnation',
    }),
    writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-match', complete('match'), { dataDir: a, instanceId }),
  ];
  use(a);
  rmSync(configFile(a));
  assert.equal(tag(), 'match');

  const b = dir('b');
  writeFileSync(configFile(b), JSON.stringify(complete('b')));
  markUserDataInitialized(b);
  rmSync(configFile(b));
  use(b);
  assert.deepEqual(readConfig(), {});
  for (const path of entries) assert.equal(existsSync(path), true, path);
});

function writeLegacyMarker(backupRoot, dataDir) {
  mkdirSync(backupRoot, { recursive: true });
  const id = createHash('sha256').update(String(dataDir)).digest('hex').slice(0, 16);
  writeFileSync(join(backupRoot, `.initialized-${id}.json`), JSON.stringify({ dataDir }));
}

test('upgrade with config missing restores from a legacy backup verified to belong to this data dir', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  writeLegacyMarker(backupRoot, a);
  writeLegacyBackup(backupRoot, '2020-01-03T00-00-00-000Z-none', complete('none'));
  writeLegacyBackup(backupRoot, '2020-01-02T00-00-00-000Z-other', complete('other'), { dataDir: dir('other') });
  writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-match', complete('match'), { dataDir: a });
  use(a);
  assert.equal(hasUserDataInitMarker(a), false);
  assert.equal(tag(), 'match');
  assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).agent.tag, 'match');
  assert.equal(hasUserDataInitMarker(a), true);
  updateSection('ui', { theme: 'after' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent.tag, 'match');
  assert.equal(stored.ui.theme, 'after');
});

test('upgrade with config missing and only non-matching legacy backups refuses RMW writes', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  writeLegacyMarker(backupRoot, a);
  writeLegacyBackup(backupRoot, '2020-01-02T00-00-00-000Z-none', complete('none'));
  writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-other', complete('other'), { dataDir: dir('other') });
  use(a);
  assert.deepEqual(readConfig(), {});
  assert.throws(
    () => updateSection('ui', { theme: 'fresh' }),
    (err) => err.code === 'EUSERDATARECOVERY' && /older Mixdog build/.test(err.message)
  );
  assert.throws(() => updateConfig(() => complete('fresh')), { code: 'EUSERDATARECOVERY' });
  assert.equal(existsSync(configFile(a)), false);
  assert.equal(hasUserDataInitMarker(a), false);
});

test('a fresh data dir with unrelated legacy backups stays a fresh install', (t) => {
  const { dir, backupRoot } = sandbox(t);
  writeLegacyMarker(backupRoot, dir('other'));
  writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-none', complete('none'));
  const a = dir('a');
  use(a);
  assert.deepEqual(readConfig(), {});
  updateSection('ui', { theme: 'fresh' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent, undefined);
  assert.equal(stored.ui.theme, 'fresh');
});

test('readAll reuses one restore lookup until this process writes again', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  use(a);
  write('v1');
  rmSync(configFile(a));
  const original = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (path, ...args) => {
    if (String(path).startsWith(backupRoot)) scans += 1;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(tag(), 'v1');
    const first = scans;
    assert.ok(first > 0);
    for (let i = 0; i < 5; i += 1) assert.equal(tag(), 'v1');
    assert.equal(scans, first);
  } finally {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  }
  write('v2');
  rmSync(configFile(a));
  assert.equal(tag(), 'v2');
});

for (const [kind, update] of [['sync', updateSection], ['async', updateSectionAsync]]) {
  test(`${kind} RMW refreshes a restore cached while another writer held the config lock`, async (t) => {
    const { dir } = sandbox(t);
    const a = dir('a');
    use(a);
    const writer = await import(`./user-data-guard.mjs?external-${kind}-rmw`);
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    writer.backupUserData(a, 'v1');
    rmSync(configFile(a));

    // A plain read can cache a restore without persisting it while a writer
    // owns the real config lock. That cache outlives the other writer's save.
    withFileLockSync(`${configFile(a)}.lock`, () => {
      assert.equal(tag(), 'v1');
      assert.equal(existsSync(configFile(a)), false);
    });
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    await writer.backupUserDataAsync(a, 'v2');
    rmSync(configFile(a));
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v1');

    await update('ui', { theme: 'after-restore' });
    const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
    assert.equal(stored.agent.tag, 'v2');
    assert.equal(stored.ui.theme, 'after-restore');
  });

  for (const source of ['scan', 'backup.json', 'mixdog-config.json']) {
    test(`${kind} RMW ${source} EIO leaves the next plain read able to restore the latest backup`, async (t) => {
      const { dir } = sandbox(t);
      const a = dir('a');
      use(a);
      const writer = await import(`./user-data-guard.mjs?external-${kind}-rmw-${source}-eio`);
      writeFileSync(configFile(a), JSON.stringify(complete('v1')));
      const first = writer.backupUserData(a, 'v1');
      rmSync(configFile(a));
      withFileLockSync(`${configFile(a)}.lock`, () => {
        assert.deepEqual(readConfig(), complete('v1'));
        assert.equal(existsSync(configFile(a)), false);
      });

      // A failed refresh must invalidate the old hit as well as avoid caching
      // a miss: the next plain read must see the other writer's newer backup.
      writeFileSync(configFile(a), JSON.stringify(complete('v2')));
      const second = writer.backupUserData(a, 'v2');
      rmSync(configFile(a));
      const method = source === 'scan' ? 'readdirSync' : 'readFileSync';
      const targets = new Set(
        source === 'scan' ? [dirname(first.dir)] : [join(first.dir, source), join(second.dir, source)]
      );
      const original = fs[method];
      const failure = Object.assign(new Error(`${source} read failed`), { code: 'EIO' });
      fs[method] = (path, ...args) => {
        if (targets.has(path)) throw failure;
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      let caught;
      try {
        await update('ui', { theme: 'must-not-save' });
      } catch (error) {
        caught = error;
      } finally {
        fs[method] = original;
        syncBuiltinESMExports();
      }
      assert.equal(existsSync(configFile(a)), false);
      assert.deepEqual(readConfig(), complete('v2'));
      assert.deepEqual(JSON.parse(readFileSync(configFile(a), 'utf8')), complete('v2'));
      assert.equal(caught, failure);
    });
  }
}

for (const filename of ['backup.json', 'mixdog-config.json']) {
  test(`restore skips missing, malformed and non-file ${filename} entries`, (t) => {
    const { dir } = sandbox(t);
    for (const invalid of ['missing', 'malformed', 'directory']) {
      const a = dir(invalid);
      writeFileSync(configFile(a), JSON.stringify(complete('valid')));
      backupUserData(a, 'valid');
      writeFileSync(configFile(a), JSON.stringify(complete('invalid')));
      const latest = backupUserData(a, 'invalid');
      const path = join(latest.dir, filename);
      if (invalid === 'malformed') writeFileSync(path, '{broken');
      else {
        rmSync(path);
        if (invalid === 'directory') mkdirSync(path);
      }
      assert.deepEqual(loadLatestMixdogConfigFromBackup(a), complete('valid'), invalid);
    }
  });
}

for (const location of ['scope', 'root']) {
  test(`fresh restore ${location} EIO invalidates a cached miss for the next plain lookup`, async (t) => {
    const { dir, backupRoot } = sandbox(t);
    const a = dir('a');
    const instanceId = markUserDataInitialized(a);
    assert.equal(loadLatestMixdogConfigFromBackup(a), null);
    let scanDir = backupRoot;
    if (location === 'scope') {
      const writer = await import('./user-data-guard.mjs?external-miss-eio');
      writeFileSync(configFile(a), JSON.stringify(complete('v2')));
      scanDir = dirname(writer.backupUserData(a, 'v2').dir);
      rmSync(configFile(a));
    } else {
      writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-match', complete('v2'), { dataDir: a, instanceId });
    }
    const original = fs.readdirSync;
    const failure = Object.assign(new Error(`${location} read failed`), { code: 'EIO' });
    fs.readdirSync = (path, ...args) => {
      if (path === scanDir) throw failure;
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    let caught;
    try {
      loadLatestMixdogConfigFromBackup(a, { fresh: true });
    } catch (error) {
      caught = error;
    } finally {
      fs.readdirSync = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(loadLatestMixdogConfigFromBackup(a), complete('v2'));
    assert.equal(caught, failure);
  });
}

test('a fresh restore refreshes a cached miss and retains cache ownership and root isolation', async (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  markUserDataInitialized(a);
  assert.equal(loadLatestMixdogConfigFromBackup(a), null);
  const writer = await import('./user-data-guard.mjs?external-cached-miss');
  writeFileSync(configFile(a), JSON.stringify(complete('v2')));
  writer.backupUserData(a, 'v2');
  assert.equal(loadLatestMixdogConfigFromBackup(a), null);

  const restored = loadLatestMixdogConfigFromBackup(a, { fresh: true });
  assert.deepEqual(restored, complete('v2'));
  restored.agent.tag = 'caller-edit';
  assert.deepEqual(loadLatestMixdogConfigFromBackup(a), complete('v2'));

  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = dir('other-backups');
  assert.equal(loadLatestMixdogConfigFromBackup(a), null);
  assert.equal(loadLatestMixdogConfigFromBackup(a, { fresh: true }), null);
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
  assert.deepEqual(loadLatestMixdogConfigFromBackup(a), complete('v2'));
});

test('a plain read restores a deleted config once, persists it and later reads hit the file', (t) => {
  const { dir, backupRoot, scopes } = sandbox(t);
  const a = dir('a');
  use(a);
  write('v1');
  rmSync(configFile(a));
  const lines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    if (String(chunk).startsWith('[config]')) lines.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...args);
  };
  try {
    assert.equal(tag(), 'v1');
    assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).agent.tag, 'v1');
    for (let i = 0; i < 20; i += 1) assert.equal(tag(), 'v1');
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(lines.length, 1, lines.join(''));
  assert.match(lines[0], /restored mixdog-config\.json .* and saved it/);
  const backups = readdirSync(join(backupRoot, scopes()[0]));
  assert.ok(
    backups.some((name) => name.endsWith('-post-restore')),
    backups.join(',')
  );
});

test('crash recovery restores the latest backup of the same data dir', (t) => {
  const { dir } = sandbox(t);
  // Pre/post-write snapshots must retain creation order even at one clock tick.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const a = dir('a');
  use(a);
  write('v1');
  write('v2');
  writeFileSync(configFile(a), '{broken');
  assert.equal(tag(), 'v2');
  updateSection('ui', { theme: 'after-restore' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent.tag, 'v2');
  assert.equal(stored.ui.theme, 'after-restore');
});

for (const [firstKind, secondKind] of [
  ['sync', 'sync'],
  ['sync', 'async'],
  ['async', 'sync'],
  ['async', 'async'],
]) {
  test(`${firstKind}/${secondKind} snapshots in one millisecond preserve both versions and restore the latest`, async (t) => {
    const { dir } = sandbox(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const a = dir('a');
    const writers = { sync: backupUserData, async: backupUserDataAsync };
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    const first = await writers[firstKind](a, 'snapshot');
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    const second = await writers[secondKind](a, 'snapshot');
    assert.notEqual(first.dir, second.dir);
    for (const backup of [first, second]) {
      assert.match(basename(backup.dir), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-snapshot$/);
    }
    assert.equal(JSON.parse(readFileSync(join(first.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v1');
    assert.equal(JSON.parse(readFileSync(join(second.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v2');
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
  });
}

for (const kind of ['sync', 'async']) {
  test(`${kind} snapshots keep their order within a process when the clock moves backwards`, async (t) => {
    const { dir } = sandbox(t);
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const a = dir('a');
    const writeBackup = kind === 'sync' ? backupUserData : backupUserDataAsync;
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    await writeBackup(a, 'z-reason');
    t.mock.timers.setTime(now - 1_000);
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    await writeBackup(a, 'a-reason');
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
  });
}

for (const kind of ['sync', 'async']) {
  const method = kind === 'sync' ? 'backupUserData' : 'backupUserDataAsync';
  for (const clockShift of [0, -1_000]) {
    test(`a fresh ${kind} writer restores its latest snapshot with a ${clockShift}ms clock shift`, async (t) => {
      const { dir } = sandbox(t);
      const now = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now });
      const a = dir('a');
      const firstWriter = await import(`./user-data-guard.mjs?first-${kind}-${clockShift}`);
      const freshWriter = await import(`./user-data-guard.mjs?fresh-${kind}-${clockShift}`);
      writeFileSync(configFile(a), JSON.stringify(complete('v1')));
      const first = await firstWriter[method](a, 'z-reason');
      t.mock.timers.setTime(now + clockShift);
      writeFileSync(configFile(a), JSON.stringify(complete('v2')));
      const second = await freshWriter[method](a, 'a-reason');

      assert.equal(freshWriter.loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
      assert.ok(basename(second.dir) > basename(first.dir));
      assert.equal(JSON.parse(readFileSync(join(first.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v1');
    });
  }

  test(`an existing ${kind} writer follows another writer's persisted order on every snapshot`, async (t) => {
    const { dir } = sandbox(t);
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const a = dir('a');
    const writer = await import(`./user-data-guard.mjs?existing-${kind}`);
    const other = await import(`./user-data-guard.mjs?interleaved-${kind}`);
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    await writer[method](a, 'v1');
    t.mock.timers.setTime(now + 60_000);
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    const second = await other[method](a, 'v2');
    t.mock.timers.setTime(now);
    writeFileSync(configFile(a), JSON.stringify(complete('v3')));
    const third = await writer[method](a, 'v3');

    assert.equal(writer.loadLatestMixdogConfigFromBackup(a).agent.tag, 'v3');
    assert.ok(basename(third.dir) > basename(second.dir));
    assert.equal(JSON.parse(readFileSync(join(second.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v2');
  });

  test(`a fresh ${kind} writer keeps its new backup when the retention ring is full`, async (t) => {
    const { dir } = sandbox(t);
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const a = dir('a');
    const writer = await import(`./user-data-guard.mjs?ring-${kind}`);
    const backups = [];
    for (let i = 0; i < 40; i += 1) {
      writeFileSync(configFile(a), JSON.stringify(complete(`v${i}`)));
      backups.push(await writer[method](a, 'snapshot'));
    }
    const freshWriter = await import(`./user-data-guard.mjs?ring-restart-${kind}`);
    t.mock.timers.setTime(now - 1_000);
    writeFileSync(configFile(a), JSON.stringify(complete('new')));
    const newest = await freshWriter[method](a, 'snapshot');

    assert.equal(existsSync(newest.dir), true);
    assert.equal(existsSync(backups[0].dir), false);
    assert.equal(existsSync(backups[39].dir), true);
    assert.equal(readdirSync(dirname(newest.dir)).length, 40);
    assert.equal(freshWriter.loadLatestMixdogConfigFromBackup(a).agent.tag, 'new');
  });

  test(`${kind} ordering includes legacy and unfinished directories but ignores invalid dates and files`, async (t) => {
    const { dir } = sandbox(t);
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const a = dir('a');
    const writer = await import(`./user-data-guard.mjs?occupied-${kind}`);
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    const first = await writer[method](a, 'snapshot');
    const scope = dirname(first.dir);
    const legacyTime = new Date(now + 60_000).toISOString().replace(/[:.]/g, '-');
    const legacy = writeLegacyBackup(scope, `${legacyTime}-z-reason`, complete('legacy'), {
      dataDir: a,
      instanceId: writer.markUserDataInitialized(a),
    });
    const unfinishedTime = new Date(now + 60_001).toISOString().replace(/[:.]/g, '-');
    const unfinished = writeLegacyBackup(scope, `${unfinishedTime}-9999999999-snapshot`, complete('unfinished'));
    mkdirSync(join(scope, 'unrelated'));
    mkdirSync(join(scope, '9999-99-99T99-99-99-999Z-invalid'));
    mkdirSync(join(scope, '9999-02-29T00-00-00-000Z-invalid-calendar'));
    writeFileSync(join(scope, '9999-12-31T23-59-59-999Z-file'), 'not a directory');
    assert.equal(writer.loadLatestMixdogConfigFromBackup(a).agent.tag, 'legacy');

    const freshWriter = await import(`./user-data-guard.mjs?occupied-restart-${kind}`);
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    const second = await freshWriter[method](a, 'snapshot');
    assert.equal(freshWriter.loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
    assert.ok(basename(second.dir).slice(0, 24) > unfinishedTime);
    assert.equal(basename(second.dir).slice(0, 10), unfinishedTime.slice(0, 10));
    assert.equal(JSON.parse(readFileSync(join(legacy, 'mixdog-config.json'), 'utf8')).agent.tag, 'legacy');
    assert.equal(JSON.parse(readFileSync(join(unfinished, 'mixdog-config.json'), 'utf8')).agent.tag, 'unfinished');
    assert.equal(existsSync(join(unfinished, 'backup.json')), false);
  });

  test(`${kind} backups do not allocate an order when the existing scope cannot be read`, async (t) => {
    const { dir } = sandbox(t);
    const a = dir('a');
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    const writer = await import(`./user-data-guard.mjs?unreadable-${kind}`);
    const first = await writer[method](a, 'snapshot');
    const scope = dirname(first.dir);
    const before = readdirSync(scope);
    const api = kind === 'sync' ? fs : fs.promises;
    const readDir = kind === 'sync' ? 'readdirSync' : 'readdir';
    const original = api[readDir];
    api[readDir] = (path, ...args) => {
      if (path === scope) throw Object.assign(new Error('scope read failed'), { code: 'EIO' });
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(async () => writer[method](a, 'unreadable'), { code: 'EIO' });
    } finally {
      api[readDir] = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(readdirSync(scope), before);
  });
}

for (const kind of ['sync', 'async']) {
  test(`overlapping async/${kind} snapshots at one clock tick get distinct backup paths`, async (t) => {
    const { dir } = sandbox(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const a = dir('a');
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    const writeBackup = kind === 'sync' ? backupUserData : backupUserDataAsync;
    const backups = await Promise.all([backupUserDataAsync(a, 'snapshot'), writeBackup(a, 'snapshot')]);
    assert.notEqual(backups[0].dir, backups[1].dir);
    for (const backup of backups) {
      assert.equal(JSON.parse(readFileSync(join(backup.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v1');
    }
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v1');
  });
}
