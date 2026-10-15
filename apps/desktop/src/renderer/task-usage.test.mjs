import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskUsage } from './TaskUsage.tsx';

const render = (value, sessionId = 'lead') =>
  renderToStaticMarkup(React.createElement(TaskUsage, { value, sessionId }));
const snapshot = (tasks = []) => ({ version: 1, sessionId: 'lead', tasks });

test('older hosts and stale foreign-session snapshots never leak task rows', () => {
  assert.equal(render(undefined), '');
  assert.equal(render(snapshot(), 'other'), '');
  assert.equal(render({ ...snapshot(), version: 2 }), '');
  assert.match(render(snapshot()), /No recorded task runs/);
});

test('partial totals expose missing coverage and unsettled work without inventing completion', () => {
  const html = render(
    snapshot([
      {
        id: '<script>unsafe</script>',
        firstTurnMs: 1200,
        linkedSettlementMs: null,
        totals: { records: 2, input: 0, output: 7, inputMeasured: 1, outputMeasured: 2 },
        runs: { runs: 3, unsettled: 1, uncertainInputs: 1 },
        sends: { unreported: 2, unsettled: 1 },
        pendingSubmissions: 1,
        unallocatedSubmissions: 1,
        ambiguousRecords: 1,
      },
    ])
  );
  assert.match(html, /settlement is not verified completion/);
  assert.match(html, /Measured input \/ output records<\/dt><dd>1 \/ 2/);
  assert.match(html, /Linked settlement span<\/dt><dd>—/);
  assert.match(html, /Unsettled work<\/dt><dd>3/);
  assert.match(html, /Attribution gaps<\/dt><dd>3/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Input<\/dt><dd>0/);
});
