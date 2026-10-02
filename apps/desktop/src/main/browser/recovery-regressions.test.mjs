import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserDocuments, browserDocumentChanged } from './documents.ts';
import { createBrowserSettle } from './settle.ts';
import { createBrowserNetworkReports } from './network-report.ts';
import { BrowserNetworkLedger } from './network.ts';
import { pointerActions } from './actions/pointer.ts';

test('a dialog opening during a rendering checkpoint is reported as blocked, not a failed observation', async () => {
  const diagnostics = { pendingDialog: null };
  const settle = createBrowserSettle({
    diagnostics: () => diagnostics,
    renderCheckpoint: async () => {
      diagnostics.pendingDialog = { type: 'prompt' };
      throw new Error('checkpoint suspended by next prompt');
    },
  });
  const result = await settle.stepSettleResult({ isDestroyed: () => false }, undefined, true);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.text, /prompt/);
});

test('ref scrolling records its effect in the host without relying on page-world observer globals', async () => {
  const dom = new JSDOM('<div id="list" style="overflow:auto"></div>', { runScripts: 'outside-only' });
  const debug = new EventEmitter();
  const guest = new EventEmitter();
  const documents = createBrowserDocuments({
    sessions: () => new Map(),
    cdp: {
      guestDebugger: async () => debug,
      call: async (_guest, method) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        return { result: { value: '1:0:800:600:0:0:0:0' } };
      },
    },
  });
  try {
    const scroller = dom.window.document.querySelector('#list');
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, { scrollHeight: { value: 200 }, clientHeight: { value: 100 } });
    scroller.scrollBy = ({ top }) => {
      scroller.scrollTop = Math.min(100, scroller.scrollTop + top);
    };
    dom.window.element = scroller;
    assert.equal(dom.window.__mixdogObservationRevision, undefined);
    const context = {
      guest,
      command: { action: 'scroll', ref: 'ref', dy: 100 },
      refRecovery: {},
      services: {
        documents,
        state: { invalidateInteraction() {} },
        reply: {
          withRefRecovery: async (_guest, _recovery, ref, operation) => operation(ref),
          decorateRecovery: (result) => result,
        },
        refActions: { prepareRef: async (_guest, ref) => ref },
        snapshots: { evaluateRefScript: async (_guest, _ref, script) => dom.window.eval(script) },
      },
      actionSnapshot: async () => ({ text: 'observed' }),
    };
    const before = await documents.revision(guest);
    await pointerActions.scroll(context);
    const after = await documents.revision(guest);
    assert.equal(scroller.scrollTop, 100);
    assert.equal(browserDocumentChanged(before, after), false);
    assert.equal(browserDocumentChanged(before, after, { includeScroll: true }), true);
    await pointerActions.scroll(context);
    assert.equal(await documents.revision(guest), after);
  } finally {
    dom.window.close();
  }
});

test('mocked base64 text uses its Content-Type header when Chromium omits MIME, but binary stays omitted', async () => {
  for (const [contentType, visible] of [
    ['text/html; charset=utf-8', true],
    ['application/octet-stream', false],
  ]) {
    const ledger = new BrowserNetworkLedger();
    const request = ledger.requestWillBeSent({
      requestId: 'one',
      type: 'Fetch',
      request: { method: 'GET', url: 'https://example.test/', headers: {} },
    });
    ledger.responseReceived({
      requestId: 'one',
      type: 'Fetch',
      response: { status: 200, headers: { 'Content-Type': contentType }, mimeType: '' },
    });
    ledger.loadingFinished({ requestId: 'one' });
    const reports = createBrowserNetworkReports({
      ledgerFor: () => ledger,
      maxBodyChars: 30000,
      cdp: { call: async () => ({ body: Buffer.from('한글 body 007').toString('base64'), base64Encoded: true }) },
    });
    const result = await reports.networkDetailResult({}, request, {});
    assert.equal(result.text.includes('한글 body 007'), visible);
    assert.equal(result.text.includes('Binary response body omitted'), !visible);
  }
});
