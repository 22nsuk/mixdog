// Agent tags in the review sources list are user data, not catalog keys: a tag
// that happens to spell a UI word must not be translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import i18n, { t as translate } from './i18n';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);

test('turn review shows an agent tag verbatim in every UI language', async (t) => {
  const { dom, restore } = installTestDom(null, { html: '<!doctype html><div id="root"></div>' });
  dom.window.mixdogDesktop = {};
  await i18n.changeLanguage('ko');
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await i18n.changeLanguage('en');
    restore();
  });
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  rememberAgentReviews('draft:none', [{ sessionId: 'child', agent: 'Plan', tag: null, patch }], null, [], '', '');
  await act(async () => {
    root.render(React.createElement(TurnReviewBar, { items: [], active: false, cwd: '' }));
  });
  const document = dom.window.document;
  await act(async () => document.querySelector('.turn-review-summary').click());
  const labels = [...document.querySelectorAll('.turn-review-source strong')].map((node) => node.textContent);
  // The tag spells a catalog key, so translating it would visibly change it.
  assert.notEqual(translate('Plan'), 'Plan');
  assert.deepEqual(labels, ['Plan']);
});
