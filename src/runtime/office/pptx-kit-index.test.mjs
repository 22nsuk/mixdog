import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { KIT_INDEX_PATH, buildKitIndex } from '../../../scripts/pptx-kit-index.mjs';

// The pptx skill reads its helpers through the index; a helper added, renamed, or re-documented in kit.md, charts.md,
// or pictures.md without regenerating it would reach the model under its old signature, or not at all.
test('the pptx kit index is current with the helpers the runtime runs', async () => {
  const current = await readFile(KIT_INDEX_PATH, 'utf8');
  assert.equal(current, buildKitIndex(), 'run node scripts/pptx-kit-index.mjs');
  for (const helper of ['deck', 'head', 'avail', 'reading', 'columns', 'chart', 'picture', 'poster']) {
    assert.match(current, new RegExp(`function ${helper}\\(|const ${helper} = `), `${helper} is indexed`);
  }
});
