import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';
import { formatAggregateDetail, summarizeToolResult } from '../../../../src/runtime/shared/tool-surface.mjs';

test('turn review headlines exclude filename dates for individual and aggregated edits', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
  const previous = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.mixdogDesktop = {};
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  // The turn keeps its prompt row: rows without one are a cut-off tail, whose
  // headline shows the review's own totals instead of the edit workload.
  const prompt = { kind: 'user', id: 'line-stats-prompt', text: 'write the report' };
  rememberAgentReviews(
    'line-stats-test:line-stats-prompt',
    [],
    '',
    [{ path: 'report-20260920.md', status: 'A', additions: 292, deletions: 0 }],
    'worktree',
    ''
  );
  const created = {
    kind: 'tool',
    id: 'create-report',
    name: 'apply_patch',
    args: {},
    result: 'OK Add report-20260920.md — +292',
  };
  const modified = {
    kind: 'tool',
    id: 'modify-report',
    name: 'apply_patch',
    args: {},
    result: 'OK Modify report-20260920.md — +1/-2',
  };
  const render = async (items) =>
    act(async () => {
      root.render(
        React.createElement(TurnReviewBar, {
          items,
          sessionId: 'line-stats-test',
          active: false,
          cwd: 'C:\\Project\\owner',
        })
      );
    });
  const document = dom.window.document;
  await render([prompt, created]);
  assert.equal(document.querySelector('.turn-review-summary .diff-stats i')?.textContent, '+292');
  assert.equal(document.querySelector('.turn-review-summary .diff-stats em'), null);

  await render([prompt, created, modified]);
  assert.equal(document.querySelector('.turn-review-summary .diff-stats i')?.textContent, '+293');
  assert.equal(document.querySelector('.turn-review-summary .diff-stats em')?.textContent, '-2');

  await render([
    prompt,
    {
      ...created,
      aggregate: true,
      count: 2,
      categories: { Patch: { count: 2 } },
      result: formatAggregateDetail(
        [created, modified].map((item) => summarizeToolResult(item.name, item.args, item.result))
      ),
    },
  ]);
  assert.equal(document.querySelector('.turn-review-summary .diff-stats i')?.textContent, '+293');
  assert.equal(document.querySelector('.turn-review-summary .diff-stats em')?.textContent, '-2');
});
