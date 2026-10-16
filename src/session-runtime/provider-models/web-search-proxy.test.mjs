import assert from 'node:assert/strict';
import test from 'node:test';
import * as registry from '../../runtime/agent/orchestrator/providers/registry.mjs';
import {
  ModelProxyChannel,
  MODEL_PROXY_OPERATIONS,
  encodeModelProxyWire,
  installModelProxyChannel,
} from '../../runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { _resetModelProxyProviderConfigForTest } from '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs';
import { createProviderModels } from '../provider-models.mjs';
import { createQuickModelRows } from '../quick-model-rows.mjs';
import { providerModelCacheRow } from '../model-recency.mjs';
import { makeWebSearchCapableFor } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { webSearchProviderFamily } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { providerSetup } from '../services/provider-admin.mjs';

const webSearchCapableFor = makeWebSearchCapableFor(webSearchProviderFamily, () => null);

for (const forceFirstRead of [false, true]) {
  test(`remote web-search uses desktop providers on ${forceFirstRead ? 'forced' : 'cold'} load and after provider/host changes`, async (t) => {
    // Registry refresh also fetches public pricing overlays. Keep their
    // network latency out of the controlled proxy reply ordering below.
    t.mock.method(globalThis, 'fetch', async () => Response.json({}));
    const prior = process.env.MIXDOG_MODEL_PROXY;
    process.env.MIXDOG_MODEL_PROXY = 'client';
    _resetModelProxyProviderConfigForTest();
    t.after(() => {
      if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
      else process.env.MIXDOG_MODEL_PROXY = prior;
      _resetModelProxyProviderConfigForTest();
    });
    const channel = new ModelProxyChannel();
    t.after(installModelProxyChannel(channel));
    let providers = { openai: { enabled: true }, gemini: { enabled: false } };
    const calls = [];
    const configGates = [];
    const attach = () =>
      channel.attachPublisher((snapshot) => {
        for (const { id } of snapshot.requests) {
          const claim = channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]);
          if (!claim) continue;
          const payload = JSON.parse(claim.payload);
          calls.push(payload);
          let value;
          if (payload.method === 'providerConfig') value = { providers, ready: true };
          else {
            assert.ok(['listModels', 'refreshModels'].includes(payload.method));
            assert.equal(providers[payload.provider]?.enabled, true, 'only desktop-enabled providers may be queried');
            value = {
              models: [
                // Current catalogs can declare tools without a boolean flag.
                { id: `${payload.provider}-search`, supportedTools: ['web_search'] },
                { id: `${payload.provider}-plain`, supportsWebSearch: false, supportedTools: ['web_search'] },
                { id: { openai: 'gpt-4-turbo', gemini: 'gemini-1.5-pro', anthropic: 'claude-3-opus' }[payload.provider] },
                {
                  id: `${payload.provider}-hidden`,
                  supportsWebSearch: true,
                  hidden: true,
                },
              ],
            };
          }
          const gate = payload.method === 'providerConfig' ? configGates.shift() : null;
          const reply = () => channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [
            id, true, encodeModelProxyWire(gate?.value ?? value), null,
          ]);
          if (gate) {
            gate.received.resolve();
            void gate.release.promise.then(reply);
          } else queueMicrotask(reply);
        }
      });
    let detach = attach();
    t.after(() => detach());
    const quickHelpers = {};
    let ready;
    const api = createProviderModels({
      caches: {
        providerModelsLoadSeq: 0,
        providerModelsCache: { models: null, at: 0 },
        providerModelsPromise: null,
        webSearchProviderModelsCache: { models: null, at: 0 },
      },
      modelMetaByRoute: new Map(),
      getRoute: () => ({}),
      // Remote credentials are absent, and an unrelated server-only entry must
      // never contribute either a model or a provider to the desktop projection.
      getConfig: () => ({
        providers: { openai: { enabled: false }, deepseek: { enabled: true } },
      }),
      getReg: () => registry,
      webSearchCapableFor,
      sortProviderModelsRaw: (models) => models,
      providerModelCacheRowRaw: providerModelCacheRow,
      normalizeWebSearchProviderId: (name) => name,
      isWebSearchCapableProvider: () => true,
      ensureFullConfig() {},
      awaitKeychainPrewarm: async () => {},
      ensureProvidersReady: () => (ready ??= registry.initProviders({})),
      bootProfile() {},
      scheduleProviderModelWarmup() {},
      quickHelpers,
    });
    Object.assign(
      quickHelpers,
      createQuickModelRows({
        getRoute: () => ({}),
        getWebSearchRoute: () => null,
        displayConfig: () => assert.fail('remote web-search must not use server-local quick rows'),
        providerModelCacheRow: api.providerModelCacheRow,
        providerModelsFromCacheRows: api.providerModelsFromCacheRows,
        sortProviderModels: api.sortProviderModels,
        modelMetaByRoute: new Map(),
        modelMetaKey: api.modelMetaKey,
        normalizeWebSearchProviderId: (name) => name,
        normalizeWebSearchRouteConfig: () => null,
        isWebSearchCapableProvider: () => true,
        webSearchCapableFor,
        currentMainWebSearchModelMeta: () => null,
      })
    );
    const ids = (models) => models.map((row) => row.id).sort();
    const first = await api.collectWebSearchProviderModels({
      force: forceFirstRead,
    });
    assert.deepEqual(ids(first), ['openai-search']);
    assert.equal(first[0].webSearchCapable, true);
    assert.equal(first[0].webSearchToolType, 'web_search');
    assert.deepEqual(Object.keys(await api.enabledWebSearchProviderConfig()), ['openai']);
    const callsBefore = calls.length;
    assert.deepEqual(ids(await api.collectWebSearchProviderModels()), ['openai-search']);
    assert.equal(calls.length, callsBefore, 'a warm web-search read reuses the shared model catalog');

    providers = { openai: { enabled: true }, gemini: { enabled: true } };
    assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), [
      'gemini-search',
      'openai-search',
    ]);
    assert.ok(calls.some((call) => call.provider === 'gemini' && call.method === 'refreshModels'));
    providers = { openai: { enabled: false }, gemini: { enabled: true } };
    assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['gemini-search']);

    // Reconnection may bring a different desktop/host allow-list while the
    // daemon's readiness promise and server-local config remain unchanged.
    detach();
    providers = { anthropic: { enabled: true } };
    detach = attach();
    assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['anthropic-search']);
    assert.deepEqual(ids(await api.collectWebSearchProviderModels()), ['anthropic-search']);

    for (const firstReply of ['catalog', 'setup']) {
      await t.test(`concurrent forced setup and catalog reads keep new models when ${firstReply} replies first`, { timeout: 5_000 }, async () => {
        // Seed the still-valid 15s cache with only Anthropic, then add Gemini.
        providers = { anthropic: { enabled: true } };
        await api.collectWebSearchProviderModels({ force: true });
        providers = { anthropic: { enabled: true }, gemini: { enabled: true } };
        const catalogGate = { received: Promise.withResolvers(), release: Promise.withResolvers() };
        const setupGate = { received: Promise.withResolvers(), release: Promise.withResolvers() };
        configGates.push(catalogGate, setupGate);
        const catalog = api.collectWebSearchProviderModels({ force: true });
        await catalogGate.received.promise;
        const setup = providerSetup({}, { force: true });
        await setupGate.received.promise;
        try {
          if (firstReply === 'catalog') {
            catalogGate.release.resolve();
            // The newer setup request is still in flight: the catalog cannot
            // rely on publishing its snapshot to the shared config cache.
            assert.deepEqual(ids(await catalog), ['anthropic-search', 'gemini-search']);
            setupGate.release.resolve();
          } else {
            setupGate.release.resolve();
            await setup;
            catalogGate.release.resolve();
            assert.deepEqual(ids(await catalog), ['anthropic-search', 'gemini-search']);
          }
          assert.equal((await setup).api.find((row) => row.id === 'gemini').usable, true);
          assert.deepEqual(ids(await api.collectWebSearchProviderModels()), ['anthropic-search', 'gemini-search']);
        } finally {
          catalogGate.release.resolve();
          setupGate.release.resolve();
          await Promise.allSettled([catalog, setup]);
        }
      });
    }

    for (const emptyProviders of [{ anthropic: { enabled: false } }, {}]) {
      await t.test(`removing the last desktop provider keeps ${Object.keys(emptyProviders).length ? 'disabled' : 'empty'} catalogs empty`, async () => {
        providers = { anthropic: { enabled: true } };
        assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['anthropic-search']);
        const revision = registry.providerCatalogRevision();
        providers = emptyProviders;
        assert.deepEqual(await api.collectWebSearchProviderModels({ force: true }), []);
        assert.ok(registry.providerCatalogRevision() > revision, 'all consumers must invalidate the removed provider');
        const callsAfterRemoval = calls.length;
        assert.deepEqual(await api.collectWebSearchProviderModels(), [], 'ordinary reads must not resurrect old search rows');
        assert.deepEqual(await api.collectProviderModels(), [], 'the shared main catalog must also be empty');
        assert.deepEqual(await api.collectProviderModels({ quick: true }), []);
        assert.equal(calls.length, callsAfterRemoval, 'the confirmed empty catalog is reusable');
        assert.deepEqual([...registry.getAllProviders()], [], 'desktop-confirmed removal retires the proxy adapters');
        providers = { openai: { enabled: true } };
        assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['openai-search']);
      });
    }

    await t.test('an unready empty desktop reply preserves the live registry until a ready reply arrives', { timeout: 5_000 }, async (t) => {
      providers = { openai: { enabled: true } };
      assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['openai-search']);
      // The config retry timer is intentionally unref'ed in production.
      const keepAlive = setInterval(() => {}, 1_000);
      t.after(() => clearInterval(keepAlive));
      const unready = {
        received: Promise.withResolvers(), release: Promise.withResolvers(),
        value: { ready: false, providers: {} },
      };
      const recovered = { received: Promise.withResolvers(), release: Promise.withResolvers() };
      configGates.push(unready, recovered);
      const provider = registry.getProvider('openai');
      const revision = registry.providerCatalogRevision();
      const loading = api.collectWebSearchProviderModels({ force: true });
      try {
        await unready.received.promise;
        unready.release.resolve();
        await recovered.received.promise;
        assert.equal(registry.getProvider('openai'), provider);
        assert.equal(registry.providerCatalogRevision(), revision);
        recovered.release.resolve();
        assert.deepEqual(ids(await loading), ['openai-search']);
      } finally {
        unready.release.resolve();
        recovered.release.resolve();
        await Promise.allSettled([loading]);
      }
    });
  });
}
