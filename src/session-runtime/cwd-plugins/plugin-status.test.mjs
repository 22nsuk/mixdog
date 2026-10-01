import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createPluginStatus } from './plugin-status.mjs';

test('missing roots are listed by id/name and unparseable manifests are invalid', () => {
  const base = mkdtempSync(join(tmpdir(), 'plugin-status-'));
  const badRoot = join(base, 'bad');
  const goodRoot = join(base, 'good');
  mkdirSync(badRoot);
  mkdirSync(goodRoot);
  writeFileSync(join(badRoot, 'plugin.json'), '{ nope');
  writeFileSync(join(goodRoot, 'plugin.json'), '{"name":"good"}');
  const entries = [
    { id: 'bad', name: 'bad', root: badRoot },
    { id: 'good', name: 'good', root: goodRoot },
    { id: 'gone', name: 'gone', root: join(base, 'gone') },
  ];
  const { pluginsStatus } = createPluginStatus({
    getConfig: () => ({}),
    listRegisteredPlugins: () => entries,
    pluginAdminStatus: () => ({ registryPath: 'r', installRoot: 'i' }),
    pluginManifest: () => ({}),
    pluginMcpServerName: (plugin) => plugin.id,
    countSkillFiles: () => 0,
    clean: (value) => (typeof value === 'string' ? value.trim() : ''),
    resolve,
    statSync,
    existsSync,
    cfgMod: {},
  });
  const status = pluginsStatus();
  assert.deepEqual(status.missing, [{ id: 'gone', name: 'gone', enabled: true }]);
  assert.deepEqual(status.plugins.map((plugin) => plugin.id).sort(), ['bad', 'good']);
  assert.equal(status.plugins.find((plugin) => plugin.id === 'bad').invalid, true);
  assert.equal(status.plugins.find((plugin) => plugin.id === 'good').invalid, undefined);
});
