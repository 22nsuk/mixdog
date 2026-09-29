import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';
import { installReviewDom } from './turn-review-test-support.mjs';
import { formatAggregateDetail, summarizeToolResult } from '../../../../src/runtime/shared/tool-surface.mjs';

test('turn review headlines exclude filename dates for individual and aggregated edits', async (t) => {
  const { dom, root } = installReviewDom(t);
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
