import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Exercise the real service, normalizer and locked config patch writer. Only
// the OS keychain is replaced; every config read/write uses this test's disk.
const root = mkdtempSync(join(tmpdir(), 'mixdog-custom-provider-save-'));
const originalEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (!/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|NODE_TEST_CONTEXT)$/i.test(key)) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  USERPROFILE: root,
  APPDATA: join(root, 'appdata'),
  LOCALAPPDATA: join(root, 'localappdata'),
  MIXDOG_HOME: root,
  MIXDOG_DATA_DIR: join(root, 'data'),
  MIXDOG_CONFIG_READ_TTL_MS: '0',
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
});
test.after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

const secrets = new Map();
let keyWriteBarrier = null;
const keychain = {
  SERVICE: 'mixdog',
  getSecret: (account) => secrets.get(account) || null,
  getSecretAsync: async (account) => secrets.get(account) || null,
  hasSecret: (account) => secrets.has(account),
  setSecret: (account, value) => secrets.set(account, value),
  setSecretAsync: async (account, value) => {
    if (keyWriteBarrier?.account === account) {
      const barrier = keyWriteBarrier;
      barrier.entered.resolve();
      await barrier.released.promise;
    }
    secrets.set(account, value);
  },
  deleteSecret: (account) => secrets.delete(account),
  deleteSecretAsync: async (account) => secrets.delete(account),
  invalidateSecretCache() {},
  prewarmSecrets: async () => {},
  keychainStatus: () => ({ state: 'ok', message: '' }),
};
mock.module('../../lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });

const cfgMod = await import('../../runtime/agent/orchestrator/config.mjs');
const admin = await import('./provider-admin.mjs');

const baseURL = 'http://localhost:1234/v1';
const initialOverride = { manual: true, hidden: false, name: 'M', contextWindow: 8000 };
const initialKey = 'provider-save-fixture-original';
const replacementKey = 'provider-save-fixture-replacement';
const envName = 'MIXDOG_TEST_CUSTOM_PROVIDER_SAVE_KEY';
const stored = () => JSON.parse(readFileSync(join(root, 'data', 'mixdog-config.json'), 'utf8')).agent;

function register(extra = {}) {
  return admin.saveCustomProvider(cfgMod, {
    schemaVersion: 2,
    name: 'Before',
    protocol: 'openai-chat',
    baseURL,
    auth: 'none',
    modelOverrides: { m: initialOverride },
    ...extra,
  });
}

function edit(id, extra = {}) {
  return { id, schemaVersion: 2, name: 'After', protocol: 'openai-chat', baseURL, ...extra };
}

async function saveDuringKeyWrite(id, input, change) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  assert.equal(keyWriteBarrier, null);
  keyWriteBarrier = { account: `agent.${id}.apiKey`, entered, released };
  const saving = admin.saveCustomProvider(cfgMod, input);
  let result;
  try {
    await Promise.race([
      entered.promise,
      saving.then(() => assert.fail('the save completed without reaching its keychain write')),
    ]);
    await change();
  } finally {
    keyWriteBarrier = null;
    released.resolve();
    result = await saving;
  }
  return result;
}

test('a provider save preserves hidden and favorite edits made during input resolution', async () => {
  const { id } = await register();
  // The service yields during input resolution even with the module loaded.
  // The synchronous preference save lands before the provider save resumes.
  const saving = admin.saveCustomProvider(cfgMod, edit(id));
  admin.saveModelPreferences(cfgMod, id, [
    { model: 'm', hidden: true, favorite: true },
    { model: 'new-model', hidden: false, favorite: true },
  ]);
  const result = await saving;
  const expected = {
    m: { ...initialOverride, hidden: true },
    'new-model': { hidden: false },
  };
  const disk = stored();
  assert.equal(disk.providers[id].name, 'After');
  assert.deepEqual(disk.providers[id].modelOverrides, expected);
  assert.deepEqual(result.modelOverrides, expected);
  assert.deepEqual(disk.modelSettings[`${id}/m`], { favorite: true });
  assert.deepEqual(disk.modelSettings[`${id}/new-model`], { favorite: true });
});

test('a save cannot recreate a provider removed during input resolution', async () => {
  const { id } = await register();
  const saving = admin.saveCustomProvider(cfgMod, edit(id));
  const current = cfgMod.loadConfig();
  const { [id]: _removed, ...providers } = current.providers;
  cfgMod.saveConfig({ ...current, providers }, { baseConfig: current });
  await assert.rejects(saving, /unknown custom provider/);
  assert.equal(stored().providers[id], undefined);
});

test('an omitted auth mode is validated against the latest direct-key requirement', async () => {
  const { id } = await register();
  const saving = admin.saveCustomProvider(cfgMod, edit(id));
  const current = cfgMod.loadConfig();
  cfgMod.saveConfig(
    { ...current, providers: { ...current.providers, [id]: { ...current.providers[id], auth: 'key' } } },
    { baseConfig: current }
  );
  await assert.rejects(saving, /API key is required/);
  assert.equal(stored().providers[id].auth, 'key');
  assert.equal(stored().providers[id].name, 'Before');
  assert.equal(secrets.has(`agent.${id}.apiKey`), false);
});

for (const [label, modelOverrides] of [
  ['an explicit empty override map', {}],
  ['an explicit false equal to the original value', { m: initialOverride }],
]) {
  test(`${label} still replaces intervening model visibility edits`, async () => {
    const { id } = await register();
    const saving = admin.saveCustomProvider(cfgMod, edit(id, { modelOverrides }));
    admin.saveModelPreferences(cfgMod, id, [
      { model: 'm', hidden: true, favorite: true },
      { model: 'new-model', hidden: false },
    ]);
    const result = await saving;
    const disk = stored();
    assert.deepEqual(disk.providers[id].modelOverrides, modelOverrides);
    assert.deepEqual(result.modelOverrides, modelOverrides);
    assert.deepEqual(disk.modelSettings[`${id}/m`], { favorite: true });
  });
}

test('a provider save keeps model patches made while its keychain write is pending', async () => {
  const { id } = await register({ auth: 'key', apiKey: initialKey });
  const result = await saveDuringKeyWrite(id, edit(id, { apiKey: replacementKey }), async () => {
    await admin.updateCustomProviderModel(cfgMod, id, 'm', {
      name: 'Edited model',
      hidden: true,
      reasoning: { levels: ['low', 'high'], replay: false },
    });
    await admin.updateCustomProviderModel(cfgMod, id, 'new-model', { manual: true, hidden: false });
  });
  const expected = {
    m: {
      ...initialOverride,
      name: 'Edited model',
      hidden: true,
      reasoning: { levels: ['low', 'high'], replay: false },
    },
    'new-model': { manual: true, hidden: false },
  };
  assert.deepEqual(stored().providers[id].modelOverrides, expected);
  assert.deepEqual(result.modelOverrides, expected);
  assert.equal(result.name, 'After');
  assert.equal(secrets.get(`agent.${id}.apiKey`), replacementKey);
  assert.equal(JSON.stringify(stored()).includes(replacementKey), false);
  assert.equal(JSON.stringify(result).includes(replacementKey), false);
});

test('a final validation failure preserves the peer config and restores the previous key', async () => {
  const { id } = await register({ auth: 'key', apiKey: initialKey });
  let peerEntry;
  await assert.rejects(
    saveDuringKeyWrite(id, edit(id, { apiKey: replacementKey, wires: ['chat'] }), async () => {
      await admin.saveCustomProvider(
        cfgMod,
        edit(id, { name: 'Peer', wires: ['chat', 'responses'], modelWires: { m: 'responses' } })
      );
      peerEntry = stored().providers[id];
    }),
    /modelWires/
  );
  assert.deepEqual(stored().providers[id], peerEntry);
  assert.equal(secrets.get(`agent.${id}.apiKey`), initialKey);
});

for (const authSettings of [{ auth: 'none' }, { auth: 'key', apiKeyEnv: envName }]) {
  test(`a pending save preserves newly stored ${authSettings.apiKeyEnv ? 'environment' : 'keyless'} auth and v2 settings`, async () => {
    const { id } = await register({ auth: 'key', apiKey: initialKey });
    const latest = {
      ...authSettings,
      discovery: { newModelsHidden: true },
      wires: ['chat', 'responses'],
      modelWires: { m: 'responses' },
    };
    const result = await saveDuringKeyWrite(id, edit(id, { apiKey: replacementKey }), () =>
      admin.saveCustomProvider(cfgMod, edit(id, { name: 'Peer', ...latest }))
    );
    const expected = {
      type: 'custom',
      schemaVersion: 2,
      name: 'After',
      protocol: 'openai-chat',
      baseURL,
      enabled: true,
      modelOverrides: { m: initialOverride },
      ...latest,
    };
    assert.deepEqual(stored().providers[id], expected);
    for (const field of ['auth', 'apiKeyEnv', 'discovery', 'wires', 'modelWires']) {
      assert.deepEqual(result[field], expected[field], field);
    }
  });
}

test('explicit auth, environment clearing and v2 settings win over intervening settings', async () => {
  const { id } = await register({ auth: 'key', apiKey: initialKey });
  const stated = {
    auth: 'key',
    apiKeyEnv: null,
    discovery: { newModelsHidden: false },
    wires: ['chat'],
    modelWires: {},
  };
  const result = await saveDuringKeyWrite(id, edit(id, { apiKey: replacementKey, ...stated }), () =>
    admin.saveCustomProvider(
      cfgMod,
      edit(id, {
        auth: 'key',
        apiKeyEnv: envName,
        discovery: { newModelsHidden: true },
        wires: ['chat', 'responses'],
        modelWires: { m: 'responses' },
      })
    )
  );
  const entry = stored().providers[id];
  assert.equal(entry.auth, 'key');
  assert.equal(Object.hasOwn(entry, 'apiKeyEnv'), false);
  assert.deepEqual(entry.discovery, { newModelsHidden: false });
  assert.deepEqual(entry.wires, ['chat']);
  assert.equal(Object.hasOwn(entry, 'modelWires'), false);
  assert.equal(result.apiKeyEnv, undefined);
  assert.equal(result.modelWires, undefined);
});

for (const [label, input, expected] of [
  [
    'legacy model replacement',
    { name: 'Legacy', protocol: 'openai-chat', baseURL, models: [{ id: 'replacement', contextWindow: 4096 }] },
    {
      name: 'Legacy',
      protocol: 'openai-chat',
      discovery: { newModelsHidden: true },
      modelOverrides: { replacement: { manual: true, hidden: false, contextWindow: 4096 } },
    },
  ],
  [
    'a protocol change',
    { schemaVersion: 2, name: 'Anthropic', protocol: 'anthropic', baseURL },
    {
      name: 'Anthropic',
      protocol: 'anthropic',
      discovery: { newModelsHidden: false },
      modelOverrides: { m: initialOverride },
    },
  ],
]) {
  test(`${label} keeps its existing auth and model-list contract`, async () => {
    const { id } = await register({ wires: ['chat', 'responses'], modelWires: { m: 'responses' } });
    const result = await admin.saveCustomProvider(cfgMod, { id, ...input });
    const entry = stored().providers[id];
    assert.deepEqual(entry, {
      type: 'custom',
      schemaVersion: 2,
      enabled: true,
      auth: 'none',
      baseURL,
      ...expected,
    });
    assert.equal(result.auth, 'none');
    assert.deepEqual(result.modelOverrides, expected.modelOverrides);
    assert.equal(result.wires, undefined);
    assert.equal(result.modelWires, undefined);
  });
}
