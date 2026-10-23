import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import test from 'node:test';

import { readConfig, updateSection, updateSectionAsync } from './config.mjs';
import {
  backupUserData,
  backupUserDataAsync,
  ensureUserDataInitialized,
  loadLatestMixdogConfigFromBackup,
  markUserDataInitialized,
} from './user-data-guard.mjs';

const originalReadFileSync = fs.readFileSync;
const originalConfig = {
  agent: { model: 'kept-model' },
  channels: { access: { mode: 'restricted' } },
  ui: { theme: 'before' },
};

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-init-marker-'));
  const dataDir = join(root, 'data');
  const backupRoot = join(root, 'backups');
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_USER_DATA_BACKUP_ROOT: backupRoot,
    MIXDOG_SETUP_QUIET: '1',
    MIXDOG_SKIP_USER_DATA_BACKUP: '0',
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  mkdirSync(dataDir);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    dataDir,
    backupRoot,
    configPath: join(dataDir, 'mixdog-config.json'),
    markerPath: join(dataDir, '.mixdog-user-data.json'),
  };
}

function completedManifests(root) {
  const manifests = {};
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'backup.json') manifests[relative(root, path)] = originalReadFileSync(path, 'utf8');
    }
  }
  visit(root);
  return manifests;
}

function readConfigInFreshProcess(state) {
  const source = `
    import { readConfig } from ${JSON.stringify(new URL('./config.mjs', import.meta.url).href)};
    process.stdout.write(JSON.stringify(readConfig()));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      MIXDOG_DATA_DIR: state.dataDir,
      MIXDOG_USER_DATA_BACKUP_ROOT: state.backupRoot,
    },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertSingleSnapshot(state, config, markerBytes) {
  const manifests = completedManifests(state.backupRoot);
  assert.equal(Object.keys(manifests).length, 1, 'exactly one completed snapshot must exist');
  assertSnapshot(state, Object.entries(manifests)[0], config, markerBytes);
  return manifests;
}

function assertSnapshot(state, [path, bytes], config, markerBytes) {
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.dataDir, state.dataDir);
  assert.equal(manifest.instanceId, JSON.parse(markerBytes).instanceId);
  assert.deepEqual(JSON.parse(readFileSync(join(state.backupRoot, dirname(path), 'mixdog-config.json'))), config);
  assert.deepEqual(readFileSync(state.markerPath), markerBytes);
}

function initialized(t) {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  backupUserData(state.dataDir, 'original');
  return {
    ...state,
    markerBytes: readFileSync(state.markerPath),
    manifests: completedManifests(state.backupRoot),
  };
}

function failMarkerReads(t, markerPath, code) {
  const error = Object.assign(new Error(`${code}: cannot read initialization marker`), { code });
  const previous = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    if (String(path) === markerPath) throw error;
    return previous(path, ...args);
  };
  syncBuiltinESMExports();
  const restore = () => {
    fs.readFileSync = previous;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { error, restore };
}

for (const [label, retry] of [
  ['the next read in the same process', () => readConfig()],
  ['a fresh process', readConfigInFreshProcess],
]) {
  test(`initial snapshot retries in ${label} after manifest publication fails`, (t) => {
    const state = sandbox(t);
    writeFileSync(state.configPath, JSON.stringify(originalConfig));
    const previous = fs.renameSync;
    let failedPublications = 0;
    fs.renameSync = (source, destination, ...args) => {
      if (basename(String(destination)) === 'backup.json') {
        failedPublications += 1;
        throw Object.assign(new Error('EIO: cannot publish backup manifest'), { code: 'EIO' });
      }
      return previous(source, destination, ...args);
    };
    syncBuiltinESMExports();
    const restore = () => {
      fs.renameSync = previous;
      syncBuiltinESMExports();
    };
    t.after(restore);

    assert.deepEqual(readConfig(), originalConfig, 'a backup failure must not hide the readable config');
    assert.equal(failedPublications, 1, 'the failure must occur while publishing the manifest');
    assert.deepEqual(completedManifests(state.backupRoot), {});
    const markerBytes = readFileSync(state.markerPath);
    assert.ok(JSON.parse(markerBytes).instanceId, 'the identity marker was published before the failure');

    restore();
    assert.deepEqual(retry(state), originalConfig);
    const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);
    assert.equal(JSON.parse(Object.values(manifests)[0]).reason, 'initial-snapshot');
    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    assert.deepEqual(
      completedManifests(state.backupRoot),
      manifests,
      'reads and restarts must not duplicate the snapshot'
    );
    assert.deepEqual(readFileSync(state.markerPath), markerBytes);

    rmSync(state.configPath);
    assert.deepEqual(readConfig(), originalConfig, 'the retried snapshot must recover a later config loss');
    assert.deepEqual(JSON.parse(readFileSync(state.configPath, 'utf8')), originalConfig);
    assert.deepEqual(readFileSync(state.markerPath), markerBytes);
  });
}

for (const [label, config] of [
  ['complete', originalConfig],
  ['sparse', { ui: { theme: 'sparse' } }],
]) {
  test(`a successful initial snapshot of a ${label} config is not repeated by reads or restarts`, (t) => {
    const state = sandbox(t);
    writeFileSync(state.configPath, JSON.stringify(config));
    assert.deepEqual(readConfig(), config);
    const markerBytes = readFileSync(state.markerPath);
    const manifests = assertSingleSnapshot(state, config, markerBytes);

    // Sparse config is a valid snapshot even when the restore policy would
    // reject it as a possible single-section wipe remnant.
    assert.deepEqual(readConfig(), config);
    assert.deepEqual(readConfig(), config);
    assert.deepEqual(readConfigInFreshProcess(state), config);
    assert.deepEqual(readConfigInFreshProcess(state), config);
    assert.deepEqual(completedManifests(state.backupRoot), manifests);
    assert.deepEqual(readFileSync(state.markerPath), markerBytes);
  });
}

test('repeated normal config reads do not reread an unchanged initialization marker', (t) => {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  assert.deepEqual(readConfig(), originalConfig);
  const markerBytes = readFileSync(state.markerPath);
  const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);
  assert.deepEqual(readConfig(), originalConfig);

  const previous = fs.readFileSync;
  let markerReads = 0;
  fs.readFileSync = (path, ...args) => {
    if (String(path) === state.markerPath) markerReads += 1;
    return previous(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = previous;
    syncBuiltinESMExports();
  });

  for (let i = 0; i < 5; i += 1) assert.deepEqual(readConfig(), originalConfig);
  assert.equal(markerReads, 0, 'unchanged profile reads must avoid repeated marker content I/O');
  assert.deepEqual(originalReadFileSync(state.markerPath), markerBytes);
  assert.deepEqual(completedManifests(state.backupRoot), manifests);
});

for (const skip of ['1', 'true']) {
  test(`MIXDOG_SKIP_USER_DATA_BACKUP=${skip} does not cache initial snapshot completion`, (t) => {
    const state = sandbox(t);
    writeFileSync(state.configPath, JSON.stringify(originalConfig));
    process.env.MIXDOG_SKIP_USER_DATA_BACKUP = skip;
    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfig(), originalConfig);
    assert.equal(existsSync(state.markerPath), false);
    assert.deepEqual(completedManifests(state.backupRoot), {});

    process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '0';
    assert.deepEqual(readConfig(), originalConfig);
    assert.equal(existsSync(state.markerPath), true, 'enabling backups must allow initialization in the same process');
    const markerBytes = readFileSync(state.markerPath);
    const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);
    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    assert.deepEqual(completedManifests(state.backupRoot), manifests);
  });
}

for (const [label, damage] of [
  ['malformed JSON', () => '{"instanceId":'],
  ['a different data directory', (manifest, state) => JSON.stringify({ ...manifest, dataDir: dirname(state.dataDir) })],
  ['a different instance', (manifest) => JSON.stringify({ ...manifest, instanceId: 'previous-incarnation' })],
]) {
  test(`a cold completion lookup rejects a manifest with ${label}`, (t) => {
    const state = sandbox(t);
    writeFileSync(state.configPath, JSON.stringify(originalConfig));
    // The child creates the snapshot without warming this process's cache.
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    const markerBytes = readFileSync(state.markerPath);
    const originalManifests = assertSingleSnapshot(state, originalConfig, markerBytes);
    const [path, bytes] = Object.entries(originalManifests)[0];
    const damaged = damage(JSON.parse(bytes), state);
    writeFileSync(join(state.backupRoot, path), damaged);

    assert.deepEqual(readConfig(), originalConfig);
    const manifests = completedManifests(state.backupRoot);
    assert.equal(Object.keys(manifests).length, 2, 'an invalid manifest must not count as completed initialization');
    assert.equal(manifests[path], damaged, 'the existing backup must remain untouched');
    const added = Object.entries(manifests).filter(([candidate]) => candidate !== path);
    assertSnapshot(state, added[0], originalConfig, markerBytes);
    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    assert.deepEqual(completedManifests(state.backupRoot), manifests);
  });
}

test('a matching unscoped manifest satisfies a cold completion lookup', (t) => {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
  const markerBytes = readFileSync(state.markerPath);
  const originalManifests = assertSingleSnapshot(state, originalConfig, markerBytes);
  const snapshotDir = dirname(Object.keys(originalManifests)[0]);
  fs.renameSync(join(state.backupRoot, snapshotDir), join(state.backupRoot, basename(snapshotDir)));
  const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);

  assert.deepEqual(readConfig(), originalConfig);
  assert.deepEqual(readConfig(), originalConfig);
  assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
  assert.deepEqual(completedManifests(state.backupRoot), manifests);
  assert.deepEqual(readFileSync(state.markerPath), markerBytes);
});

for (const [label, method, target] of [
  ['listing the scope', 'readdirSync', (manifestPath) => dirname(dirname(manifestPath))],
  ['reading a manifest', 'readFileSync', (manifestPath) => manifestPath],
]) {
  test(`a cold completion lookup retries after EIO while ${label}`, (t) => {
    const state = sandbox(t);
    writeFileSync(state.configPath, JSON.stringify(originalConfig));
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    const markerBytes = readFileSync(state.markerPath);
    const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);
    const faultPath = target(join(state.backupRoot, Object.keys(manifests)[0]));
    const previous = fs[method];
    let armed = true;
    let lookups = 0;
    fs[method] = (path, ...args) => {
      if (String(path) === faultPath) {
        lookups += 1;
        if (armed) throw Object.assign(new Error(`EIO: ${label}`), { code: 'EIO' });
      }
      return previous(path, ...args);
    };
    syncBuiltinESMExports();
    const restore = () => {
      fs[method] = previous;
      syncBuiltinESMExports();
    };
    t.after(restore);

    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfig(), originalConfig);
    assert.equal(lookups, 2, 'failed lookups must not cache completion');
    armed = false;
    assert.deepEqual(readConfig(), originalConfig);
    assert.equal(lookups, 3, 'the next read must retry the completion lookup');
    assert.deepEqual(readConfig(), originalConfig);
    assert.equal(lookups, 3, 'a successful lookup must be reused');
    restore();
    assert.deepEqual(
      completedManifests(state.backupRoot),
      manifests,
      'lookup failures must not create extra snapshots'
    );
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    assert.deepEqual(completedManifests(state.backupRoot), manifests);
    assert.deepEqual(readFileSync(state.markerPath), markerBytes);
  });
}

test('an empty initialization attempt does not cache completion before a config appears', (t) => {
  const state = sandbox(t);
  ensureUserDataInitialized(state.dataDir);
  assert.equal(existsSync(state.markerPath), false);
  assert.deepEqual(completedManifests(state.backupRoot), {});

  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  assert.deepEqual(readConfig(), originalConfig);
  const markerBytes = readFileSync(state.markerPath);
  const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);
  assert.deepEqual(readConfig(), originalConfig);
  assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
  assert.deepEqual(completedManifests(state.backupRoot), manifests);
});

test('initial snapshot completion follows a changed backup root without replacing the profile identity', (t) => {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  assert.deepEqual(readConfig(), originalConfig);
  const markerBytes = readFileSync(state.markerPath);
  const originalManifests = assertSingleSnapshot(state, originalConfig, markerBytes);

  const next = { ...state, backupRoot: join(dirname(state.backupRoot), 'other-backups') };
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = next.backupRoot;
  assert.deepEqual(readConfig(), originalConfig);
  const nextManifests = assertSingleSnapshot(next, originalConfig, markerBytes);
  assert.deepEqual(readConfig(), originalConfig);
  assert.deepEqual(readConfigInFreshProcess(next), originalConfig);
  assert.deepEqual(completedManifests(next.backupRoot), nextManifests);
  assert.deepEqual(completedManifests(state.backupRoot), originalManifests);
  assert.deepEqual(readFileSync(state.markerPath), markerBytes);
});

test('a profile recreated at the same path gets its own initial snapshot and identity', (t) => {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  assert.deepEqual(readConfig(), originalConfig);
  const markerBytes = readFileSync(state.markerPath);
  const originalManifests = assertSingleSnapshot(state, originalConfig, markerBytes);

  rmSync(state.dataDir, { recursive: true });
  mkdirSync(state.dataDir);
  const recreatedConfig = { ...originalConfig, agent: { model: 'recreated-profile-model' } };
  writeFileSync(state.configPath, JSON.stringify(recreatedConfig));
  assert.deepEqual(readConfig(), recreatedConfig);
  assert.equal(existsSync(state.markerPath), true, 'a recreated profile must not reuse cached completion');
  const nextMarkerBytes = readFileSync(state.markerPath);
  const nextInstanceId = JSON.parse(nextMarkerBytes).instanceId;
  assert.notEqual(nextInstanceId, JSON.parse(markerBytes).instanceId);
  const manifests = completedManifests(state.backupRoot);
  const added = Object.entries(manifests).filter(([path]) => !Object.hasOwn(originalManifests, path));
  assert.equal(added.length, 1);
  const [path, bytes] = added[0];
  assert.equal(JSON.parse(bytes).instanceId, nextInstanceId);
  assert.deepEqual(
    JSON.parse(readFileSync(join(state.backupRoot, dirname(path), 'mixdog-config.json'))),
    recreatedConfig
  );
  for (const [originalPath, originalBytes] of Object.entries(originalManifests)) {
    assert.equal(manifests[originalPath], originalBytes);
  }

  assert.deepEqual(readConfig(), recreatedConfig);
  assert.deepEqual(readConfigInFreshProcess(state), recreatedConfig);
  assert.deepEqual(completedManifests(state.backupRoot), manifests);
  assert.deepEqual(readFileSync(state.markerPath), nextMarkerBytes);
});

for (const [kind, backup] of [
  ['sync', backupUserData],
  ['async', backupUserDataAsync],
]) {
  test(`a completed manual ${kind} backup prevents an extra initial snapshot on reads or restarts`, async (t) => {
    const state = sandbox(t);
    writeFileSync(state.configPath, JSON.stringify(originalConfig));
    await backup(state.dataDir, 'manual');
    const markerBytes = readFileSync(state.markerPath);
    const manifests = assertSingleSnapshot(state, originalConfig, markerBytes);
    assert.equal(JSON.parse(Object.values(manifests)[0]).reason, 'manual');

    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfig(), originalConfig);
    assert.deepEqual(readConfigInFreshProcess(state), originalConfig);
    assert.deepEqual(completedManifests(state.backupRoot), manifests);
    assert.deepEqual(readFileSync(state.markerPath), markerBytes);
  });
}

for (const [kind, code, save] of [
  ['sync', 'EIO', updateSection],
  ['async', 'EACCES', updateSectionAsync],
]) {
  test(`${kind} settings save preserves a lost config and backup identity when the marker has ${code}`, async (t) => {
    const state = initialized(t);
    rmSync(state.configPath);
    const { error, restore } = failMarkerReads(t, state.markerPath, code);
    let updaterCalls = 0;
    const update = () =>
      save('ui', () => {
        updaterCalls += 1;
        return { theme: 'after' };
      });
    if (kind === 'sync') assert.throws(update, (actual) => actual === error);
    else await assert.rejects(update, (actual) => actual === error);
    assert.equal(updaterCalls, 0, 'the updater must not run with an unverified empty baseline');
    assert.throws(
      () => readConfig(),
      (actual) => actual === error
    );
    assert.throws(
      () => loadLatestMixdogConfigFromBackup(state.dataDir),
      (actual) => actual === error
    );
    assert.equal(existsSync(state.configPath), false);
    assert.deepEqual(originalReadFileSync(state.markerPath), state.markerBytes);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);

    restore();
    await save('ui', { theme: 'after' });
    const stored = JSON.parse(readFileSync(state.configPath, 'utf8'));
    assert.deepEqual(stored.agent, originalConfig.agent);
    assert.deepEqual(stored.channels, originalConfig.channels);
    assert.equal(stored.ui.theme, 'after');
    assert.deepEqual(readFileSync(state.markerPath), state.markerBytes);
    const instanceId = JSON.parse(state.markerBytes).instanceId;
    for (const manifest of Object.values(completedManifests(state.backupRoot))) {
      assert.equal(JSON.parse(manifest).instanceId, instanceId);
    }
  });
}

for (const [kind, backup] of [
  ['sync', backupUserData],
  ['async', backupUserDataAsync],
]) {
  test(`${kind} backup cannot replace an unreadable init marker or publish a new identity`, async (t) => {
    const state = initialized(t);
    const configBytes = readFileSync(state.configPath);
    const { error, restore } = failMarkerReads(t, state.markerPath, 'EIO');
    assert.throws(
      () => markUserDataInitialized(state.dataDir),
      (actual) => actual === error
    );
    const takeBackup = () => backup(state.dataDir, 'unreadable-marker');
    if (kind === 'sync') assert.throws(takeBackup, (actual) => actual === error);
    else await assert.rejects(takeBackup, (actual) => actual === error);
    assert.deepEqual(originalReadFileSync(state.markerPath), state.markerBytes);
    assert.deepEqual(readFileSync(state.configPath), configBytes);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);

    restore();
    const recovered = await backup(state.dataDir, 'readable-marker');
    assert.equal(
      JSON.parse(readFileSync(join(recovered.dir, 'backup.json'))).instanceId,
      JSON.parse(state.markerBytes).instanceId
    );
  });
}

for (const [label, damaged] of [
  ['malformed JSON', '{"instanceId":'],
  ['an invalid identity', '{"instanceId":""}'],
]) {
  test(`an init marker with ${label} is preserved until its identity can be read`, (t) => {
    const state = initialized(t);
    writeFileSync(state.markerPath, damaged);
    // The readable config remains available even while initialization cannot
    // establish which backup incarnation owns it.
    assert.deepEqual(readConfig(), originalConfig);
    const isMarkerError = (error) => error instanceof SyntaxError && error.message.includes(state.markerPath);
    assert.throws(() => markUserDataInitialized(state.dataDir), isMarkerError);
    assert.equal(readFileSync(state.markerPath, 'utf8'), damaged);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);

    rmSync(state.configPath);
    assert.throws(() => updateSection('ui', { theme: 'after' }), isMarkerError);
    assert.equal(existsSync(state.configPath), false);
    assert.equal(readFileSync(state.markerPath, 'utf8'), damaged);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);

    writeFileSync(state.markerPath, state.markerBytes);
    updateSection('ui', { theme: 'after' });
    const stored = readConfig();
    assert.deepEqual(stored.agent, originalConfig.agent);
    assert.deepEqual(stored.channels, originalConfig.channels);
    assert.equal(stored.ui.theme, 'after');
    assert.deepEqual(readFileSync(state.markerPath), state.markerBytes);
  });
}

test('a readable legacy config retries initialization after a transient marker read failure', (t) => {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  const { restore } = failMarkerReads(t, state.markerPath, 'EIO');
  assert.deepEqual(readConfig(), originalConfig);
  assert.equal(existsSync(state.markerPath), false);
  assert.deepEqual(completedManifests(state.backupRoot), {});

  restore();
  assert.deepEqual(readConfig(), originalConfig);
  assert.equal(existsSync(state.markerPath), true);
  assert.equal(Object.keys(completedManifests(state.backupRoot)).length, 1);
  rmSync(state.configPath);
  assert.deepEqual(readConfig(), originalConfig);
});

test("a marker created after an absent read retains the concurrent creator's identity", (t) => {
  const state = sandbox(t);
  const markerBytes = JSON.stringify({ instanceId: 'concurrent-profile', dataDir: state.dataDir });
  const previous = fs.readFileSync;
  let raced = false;
  fs.readFileSync = (path, ...args) => {
    if (!raced && String(path) === state.markerPath) {
      raced = true;
      // The first read observed ENOENT, then another creator won before this
      // caller could publish its marker.
      writeFileSync(state.markerPath, markerBytes);
      throw Object.assign(new Error('ENOENT: initialization marker was absent'), { code: 'ENOENT' });
    }
    return previous(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = previous;
    syncBuiltinESMExports();
  });
  assert.equal(markUserDataInitialized(state.dataDir), 'concurrent-profile');
  assert.equal(readFileSync(state.markerPath, 'utf8'), markerBytes);
});

for (const [kind, save] of [
  ['sync', updateSection],
  ['async', updateSectionAsync],
]) {
  test(`a genuinely missing initialization marker allows a fresh ${kind} settings save`, async (t) => {
    const state = sandbox(t);
    assert.deepEqual(readConfig(), {});
    await save('ui', { theme: 'fresh' });
    const markerBytes = readFileSync(state.markerPath);
    await save('agent', originalConfig.agent);
    const stored = readConfig();
    assert.equal(stored.ui.theme, 'fresh');
    assert.deepEqual(stored.agent, originalConfig.agent);
    assert.deepEqual(readFileSync(state.markerPath), markerBytes);
  });
}
