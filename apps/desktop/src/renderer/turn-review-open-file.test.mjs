import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';
import { installReviewDom } from './turn-review-test-support.mjs';

test("turn review opens the owning project's file without toggling its diff; deleted files cannot open", async (t) => {
  const { dom, root } = installReviewDom(t);
  rememberAgentReviews(
    'draft:none',
    [],
    '',
    [
      { path: 'C:/Project/owner/src/current.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/deleted.ts', status: 'D', additions: 0, deletions: 1 },
    ],
    'worktree',
    ''
  );
  const opened = [];
  const render = async (cwd = 'C:\\Project\\owner') =>
    act(async () => {
      root.render(
        React.createElement(TurnReviewBar, {
          items: [],
          active: false,
          cwd,
          onOpenFile: (...args) => opened.push(args),
        })
      );
    });
  await render();
  const document = dom.window.document;
  await act(async () => document.querySelector('.turn-review-summary').click());
  const disclosure = document.querySelector('.turn-review-file');
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  const buttons = [...document.querySelectorAll('.turn-review-open')];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  await act(async () => {
    buttons[0].click();
    buttons[1].click();
  });
  assert.deepEqual(opened, [['C:\\Project\\owner', 'src/current.ts']]);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.turn-review-summary').getAttribute('aria-expanded'), 'true');
  await render('');
  assert.equal(buttons[0].disabled, true);
});
