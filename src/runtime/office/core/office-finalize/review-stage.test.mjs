import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksFinalize } from './review-stage.mjs';

// A chart over the figures it was drawn from passed finalize on an authored workbook, whose warnings are the model's
// call: a drawing that hides cells or another drawing holds the file back on every document, other warnings do not.
test('a drawing that hides cells or another drawing holds finalize even on an authored document', () => {
  const authored = { failOn: 'error', authored: true };
  const warning = (code, source = 'format-review') => ({ severity: 'warning', code, source });
  assert.equal(blocksFinalize(warning('drawing_covers_cells'), authored), true);
  assert.equal(blocksFinalize(warning('drawing_overlap'), authored), true);
  assert.equal(
    blocksFinalize(warning('label_truncated', 'column-fit'), authored),
    false,
    'other warnings stay advisory'
  );
  assert.equal(
    blocksFinalize({ severity: 'info', code: 'drawing_overlap' }, authored),
    false,
    'an info note never holds'
  );
  assert.equal(blocksFinalize(warning('label_truncated', 'column-fit'), { failOn: 'warning', authored: false }), true);
  assert.equal(blocksFinalize(warning('low_contrast', 'text-metrics'), { failOn: 'warning', authored: true }), false);
});
