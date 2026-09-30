import assert from 'node:assert/strict';
import test from 'node:test';

import { noEnabledProvidersError } from '../../runtime/agent/orchestrator/providers/registry-errors.mjs';
import { createCatalogLoader } from './catalog-load.mjs';

function loader(ensureProvidersReady) {
  return createCatalogLoader({
    caches: { providerModelsLoadSeq: 0 },
    config: () => ({ providers: { openai: { enabled: false } } }),
    reg: () => {
      throw new Error('the catalog must not be read without an enabled provider');
    },
    meta: {},
    rows: {},
    profile: () => {},
    ensureFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady,
  });
}

test('no enabled provider loads an empty, uncached catalog instead of failing', async () => {
  const load = loader(async () => {
    throw noEnabledProvidersError('[provider] all providers disabled in config — refusing to clear registry');
  });
  const request = { seq: 0 };
  assert.deepEqual(await load({ request }), []);
  assert.notEqual(request.complete, true);
});

test('any other provider init failure still surfaces', async () => {
  const load = loader(async () => {
    throw new Error('[provider] Failed to init "openai": boom');
  });
  await assert.rejects(load({ request: { seq: 0 } }), /Failed to init "openai"/);
});
