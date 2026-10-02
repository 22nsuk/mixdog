import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDomTarget } from './dom-eval-target.mjs';

const page = (url, id = url) => ({
  id,
  type: 'page',
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9342/devtools/page/${id}`,
});
const app = page('http://127.0.0.1:5173/', 'app');
const blank = page('about:blank', 'helper');

test('default probes use the sole nonblank debuggable page regardless of target order', () => {
  const worker = { ...page('worker.js'), type: 'worker' };
  assert.equal(selectDomTarget([blank, worker, app]), app);
  assert.equal(selectDomTarget([app, blank]), app);
});

test('a built preview page is eligible without hardcoding a dev-server port', () => {
  const preview = page('file:///C:/mixdog/out/renderer/index.html');
  assert.equal(selectDomTarget([blank, preview]), preview);
});

test('ambiguous pages require an explicit unique URL', () => {
  const other = page('https://example.com/');
  assert.throws(() => selectDomTarget([app, other]), /Multiple debuggable pages/);
  assert.equal(selectDomTarget([blank, other, app], app.url), app);
  assert.throws(() => selectDomTarget([app, { ...app, id: 'duplicate' }], app.url), /Multiple/);
});

test('missing pages fail rather than falling back to blank or another URL', () => {
  for (const targets of [[], [blank], [{ ...app, webSocketDebuggerUrl: '' }]]) {
    assert.throws(() => selectDomTarget(targets), /No matching/);
  }
  assert.throws(() => selectDomTarget([app], 'http://127.0.0.1:5174/'), /No matching/);
  assert.equal(selectDomTarget([app, blank], 'about:blank'), blank, 'explicit helper inspection is allowed');
});
