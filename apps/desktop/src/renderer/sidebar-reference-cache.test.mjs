import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeModelCatalogInvalidation } from './model-catalog-cache.ts';
import {
  invalidateSidebarReferenceForMutation,
  resetSidebarReferenceCache,
  sidebarReferenceKeysForMutation,
  sidebarReferencesLoading,
  updateSidebarReference,
} from './sidebar-reference-cache.ts';

test('cold sidebar references stay loading until the complete set is available', () => {
  resetSidebarReferenceCache();
  const keys = ['workflows', 'agents'];

  assert.equal(sidebarReferencesLoading(true, false, keys), true);
  updateSidebarReference('workflows', [{ id: 'solo' }]);
  assert.equal(sidebarReferencesLoading(true, false, keys), true);
  updateSidebarReference('agents', [{ id: 'maintainer' }]);
  assert.equal(sidebarReferencesLoading(true, false, keys), false);
});

test('unavailable bridges never leave a permanent loading surface', () => {
  resetSidebarReferenceCache();
  assert.equal(sidebarReferencesLoading(false, false, ['workflows', 'agents']), false);
});

test('a Developer provider toggle retires provider references and wakes mounted model pickers', async () => {
  let woke = 0;
  const unsubscribe = subscribeModelCatalogInvalidation(() => {
    woke += 1;
  });
  try {
    assert.equal(invalidateSidebarReferenceForMutation('setDeveloperOption'), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(woke, 1);
  } finally {
    unsubscribe();
  }
  assert.deepEqual(sidebarReferenceKeysForMutation('setDeveloperOption'), [
    'providerSetup',
    'quickProviderModels',
    'webSearchModels',
  ]);
});

test('Local Provider lifecycle changes invalidate setup and model references', () => {
  for (const mutation of ['installBuiltinFeature', 'installLocalProviderModel', 'setBuiltinToolEnabled']) {
    assert.deepEqual(sidebarReferenceKeysForMutation(mutation), [
      'providerSetup',
      'quickProviderModels',
      'webSearchModels',
    ]);
  }
});
