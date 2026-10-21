import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import test from 'node:test';

import { readConfig, updateSection, updateSectionAsync } from './config.mjs';
import {
  backupUserData,
  backupUserDataAsync,
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

function initialized(t) {
  const state = sandbox(t);
  writeFileSync(state.configPath, JSON.stringify(originalConfig));
  const { dir: backupDir } = backupUserData(state.dataDir, 'original');
  return {
    ...state,
    backupDir,
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

function mockFsMethod(t, target, method, implementation) {
  const mocked = t.mock.method(target, method, implementation);
  syncBuiltinESMExports();
  const restore = () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
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
    assert.throws(() => readConfig(), (actual) => actual === error);
    assert.throws(() => loadLatestMixdogConfigFromBackup(state.dataDir), (actual) => actual === error);
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
    assert.throws(() => markUserDataInitialized(state.dataDir), (actual) => actual === error);
    const takeBackup = () => backup(state.dataDir, 'unreadable-marker');
    if (kind === 'sync') assert.throws(takeBackup, (actual) => actual === error);
    else await assert.rejects(takeBackup, (actual) => actual === error);
    assert.deepEqual(originalReadFileSync(state.markerPath), state.markerBytes);
    assert.deepEqual(readFileSync(state.configPath), configBytes);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);
    assert.deepEqual(readdirSync(dirname(state.backupDir)), [basename(state.backupDir)]);

    restore();
    const recovered = await backup(state.dataDir, 'readable-marker');
    assert.equal(
      JSON.parse(readFileSync(join(recovered.dir, 'backup.json'))).instanceId,
      JSON.parse(state.markerBytes).instanceId
    );
  });
}

for (const [kind, backup, io, readMethod, removeMethod] of [
  ['sync', backupUserData, fs, 'readFileSync', 'rmSync'],
  ['async', backupUserDataAsync, fsPromises, 'readFile', 'rm'],
]) {
  test(`${kind} backup removes a partially copied reservation without touching completed history`, async (t) => {
    const state = initialized(t);
    const scheduleDir = join(state.dataDir, 'schedules');
    mkdirSync(scheduleDir);
    const schedulePath = join(scheduleDir, 'job.json');
    writeFileSync(schedulePath, '{"schedule":"kept"}');
    const error = Object.assign(new Error('schedule read failed'), { code: 'EIO' });
    const originalRead = io[readMethod];
    mockFsMethod(t, io, readMethod, (path, ...args) => {
      if (String(path) === schedulePath) throw error;
      return originalRead(path, ...args);
    });

    await assert.rejects(async () => backup(state.dataDir, 'copy-error'), (actual) => actual === error);
    assert.deepEqual(readdirSync(dirname(state.backupDir)), [basename(state.backupDir)]);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);
    assert.deepEqual(readFileSync(state.markerPath), state.markerBytes);
    assert.deepEqual(JSON.parse(readFileSync(state.configPath, 'utf8')), originalConfig);
  });

  test(`${kind} retention ignores failed cleanup reservations but counts completed schedule-only snapshots`, async (t) => {
    const state = initialized(t);
    const scopeDir = dirname(state.backupDir);
    const { error, restore: restoreMarker } = failMarkerReads(t, state.markerPath, 'EIO');
    const cleanupError = Object.assign(new Error('reservation cleanup denied'), { code: 'EACCES' });
    const originalRemove = io[removeMethod];
    const restoreRemove = mockFsMethod(t, io, removeMethod, (path, ...args) => {
      if (dirname(String(path)) === scopeDir && String(path) !== state.backupDir) throw cleanupError;
      return originalRemove(path, ...args);
    });
    for (let index = 0; index < 40; index += 1) {
      await assert.rejects(async () => backup(state.dataDir, 'marker-error'), (actual) => actual === error);
    }
    assert.equal(readdirSync(scopeDir).length, 41);
    assert.deepEqual(completedManifests(state.backupRoot), state.manifests);
    restoreMarker();
    restoreRemove();

    const recovered = await backup(state.dataDir, 'repaired');
    assert.equal(existsSync(state.backupDir), true, 'incomplete reservations cannot evict the original backup');
    assert.equal(Object.keys(completedManifests(state.backupRoot)).length, 2);
    assert.deepEqual(loadLatestMixdogConfigFromBackup(state.dataDir, { fresh: true }), originalConfig);

    // A completed backup need not contain a config: schedules are user data too.
    rmSync(state.configPath);
    mkdirSync(join(state.dataDir, 'schedules'));
    writeFileSync(join(state.dataDir, 'schedules', 'job.json'), '{"schedule":"kept"}');
    const schedules = [];
    for (let index = 0; index < 39; index += 1) {
      schedules.push(await backup(state.dataDir, 'schedules-only'));
    }
    assert.equal(existsSync(state.backupDir), false, 'the oldest of 41 completed snapshots is pruned');
    assert.equal(existsSync(recovered.dir), true);
    assert.equal(Object.keys(completedManifests(state.backupRoot)).length, 40);
    for (const snapshot of schedules) {
      assert.equal(existsSync(join(snapshot.dir, 'mixdog-config.json')), false);
      assert.equal(readFileSync(join(snapshot.dir, 'schedules', 'job.json'), 'utf8'), '{"schedule":"kept"}');
    }
  });

  test(`${kind} backup remains committed when reporting fails after publication`, async (t) => {
    const state = initialized(t);
    process.env.MIXDOG_SETUP_QUIET = '0';
    const error = new Error('backup report failed');
    const originalWrite = process.stderr.write;
    t.mock.method(process.stderr, 'write', function (chunk, ...args) {
      if (String(chunk).startsWith('[user-data-backup]')) throw error;
      return originalWrite.call(this, chunk, ...args);
    });
    await assert.rejects(async () => backup(state.dataDir, 'published'), (actual) => actual === error);
    const manifests = completedManifests(state.backupRoot);
    assert.equal(Object.keys(manifests).length, 2);
    const published = Object.entries(manifests).filter(([, bytes]) => JSON.parse(bytes).reason === 'published');
    assert.equal(published.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(state.backupRoot, dirname(published[0][0]), 'mixdog-config.json'), 'utf8')),
      originalConfig
    );
    assert.equal(existsSync(state.backupDir), true);
  });
}

test('an init marker damaged during async copying rolls back only that reservation', async (t) => {
  const state = initialized(t);
  const originalRead = fsPromises.readFile;
  let copiedConfig = false;
  mockFsMethod(t, fsPromises, 'readFile', async (path, ...args) => {
    const bytes = await originalRead(path, ...args);
    if (String(path) === state.configPath) {
      copiedConfig = true;
      writeFileSync(state.markerPath, '{"instanceId":');
    }
    return bytes;
  });
  await assert.rejects(
    backupUserDataAsync(state.dataDir, 'marker-damaged-mid-copy'),
    (error) => error instanceof SyntaxError && error.message.includes(state.markerPath)
  );
  assert.equal(copiedConfig, true);
  assert.equal(readFileSync(state.markerPath, 'utf8'), '{"instanceId":');
  assert.deepEqual(readdirSync(dirname(state.backupDir)), [basename(state.backupDir)]);
  assert.deepEqual(completedManifests(state.backupRoot), state.manifests);
});

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

test('a marker created after an absent read retains the concurrent creator\'s identity', (t) => {
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
