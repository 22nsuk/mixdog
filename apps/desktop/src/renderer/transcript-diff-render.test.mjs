import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

test('diff collapse preserves parsed lines and selection while copy and changed patches stay current', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    jsdom: { pretendToBeVisual: true },
    expose: [
      'navigator',
      'HTMLElement',
      'Element',
      'Node',
      'MutationObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) {
        copied.push(text);
      },
    },
  });
  const { createCanvas } = await import('@napi-rs/canvas');
  t.mock.method(window.HTMLCanvasElement.prototype, 'getContext', function (kind) {
    return createCanvas(this.width, this.height).getContext(kind);
  });
  const { DiffFile } = await import('@git-diff-view/react');
  const originalInit = DiffFile.prototype.initRaw;
  let parses = 0;
  t.mock.method(DiffFile.prototype, 'initRaw', function (...args) {
    parses++;
    return originalInit.apply(this, args);
  });
  const { CodeDiff } = await import('./transcript-diff');
  const patchFor = (prefix) =>
    'diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n@@ -1,20 +1,20 @@\n' +
    Array.from({ length: 20 }, (_, index) => `-const before${index} = ${index};`).join('\n') +
    '\n' +
    Array.from({ length: 20 }, (_, index) => `+const ${prefix}${index} = ${index + 1};`).join('\n') +
    '\n';
  const patch = patchFor('after');
  await act(async () => {
    root.render(React.createElement(CodeDiff, { patch }));
    await import('./DiffView.lazy');
  });
  const table = document.querySelector('.code-diff table');
  assert.ok(table);
  assert.match(table.textContent, /before19/);
  assert.match(table.textContent, /after19/);
  const rows = [...table.querySelectorAll('tr[data-line]')];
  const lineNumbers = rows.map((row) => row.getAttribute('data-line'));
  const text = table.textContent;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(rows[0]);
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();
  assert.ok(selectedText);
  const before = parses;
  assert.ok(before > 0);
  for (const expanded of [true, false, true]) {
    await act(async () => document.querySelector('.diff-toggle').click());
    assert.equal(document.querySelector('.diff-toggle').getAttribute('aria-expanded'), String(expanded));
    assert.equal(document.querySelector('.code-diff table'), table);
    assert.equal(table.textContent, text);
    assert.deepEqual(
      [...table.querySelectorAll('tr[data-line]')].map((row) => row.getAttribute('data-line')),
      lineNumbers
    );
    assert.equal(selection.toString(), selectedText);
    assert.equal(parses, before, 'folding must not reparse an unchanged diff');
  }
  await act(async () => document.querySelector('.diff-copy').click());
  assert.equal(copied.at(-1).trim(), patch.trim());
  const updated = patchFor('revised');
  await act(async () => root.render(React.createElement(CodeDiff, { patch: updated })));
  assert.ok(parses > before, 'a genuinely changed patch must be parsed');
  assert.match(document.querySelector('.code-diff table').textContent, /revised19/);
  assert.doesNotMatch(document.querySelector('.code-diff table').textContent, /after19/);
  await act(async () => document.querySelector('.diff-copy').click());
  assert.equal(copied.at(-1).trim(), updated.trim());
});
