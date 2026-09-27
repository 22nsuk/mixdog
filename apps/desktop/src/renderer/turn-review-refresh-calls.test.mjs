import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { TurnReviewBar } from './TurnReview';
import { _runIdleReclaimForTest } from './idle-reclaim';

function mount(t) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const previous = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const pending = [];
  const requests = [];
  dom.window.mixdogDesktop = {
    invokeCapability(request) {
      requests.push(request);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const render = (items, busy) =>
    act(async () =>
      root.render(React.createElement(TurnReviewBar, { items, sessionId: 'sess-review-calls', active: true, busy }))
    );
  const answer = (value = {}) =>
    act(async () =>
      pending.shift()({
        value: {
          supported: true,
          authoritative: true,
          snapshotKind: 'worktree',
          patch: '',
          files: [],
          agents: [],
          ...value,
        },
      })
    );
  const bar = () => dom.window.document.querySelector('.turn-review-bar');
  return { render, answer, bar, pending, requests };
}

const prompt = { kind: 'user', id: 'prompt', text: 'Change a file' };
const edit = (id) => ({ kind: 'tool', id, name: 'apply_patch', args: {}, result: `Updated ${id}` });

test('a busy turn boundary reads the turn review once, not once per effect', async (t) => {
  const { render, answer, pending, requests } = mount(t);
  await render([prompt, edit('first')], true);
  assert.equal(requests.length, 1);
  await answer();
  // The boundary effect and the busy poll asked in the same commit; the read
  // already sent answered both, so no follow-up repeats it.
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 1);

  await render([prompt, edit('first'), edit('second')], true);
  assert.equal(requests.length, 2);
  await answer();
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.capability === 'getTurnReviewDiff'));
});

test('a boundary that moves while its read is in flight still gets its own read', async (t) => {
  const { render, answer, pending, requests } = mount(t);
  await render([prompt, edit('first')], true);
  assert.equal(requests.length, 1);
  await render([prompt, edit('first'), edit('second')], true);
  assert.equal(requests.length, 1, 'the newer boundary waits behind the read in flight');
  await answer();
  assert.equal(requests.length, 2, 'the newer boundary is read after the older answer');
  await answer();
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 2);
});

test("a new prompt never shows the previous turn's review the runtime still answers with", async (t) => {
  const { render, answer, bar } = mount(t);
  const earlier = [
    { kind: 'user', id: 'turn-1', text: 'First' },
    edit('earlier'),
    { kind: 'turndone', id: 'done-1' },
    { kind: 'user', id: 'turn-2', text: 'Second' },
    { kind: 'status', id: 'thinking', status: 'Thinking' },
  ];
  const changed = { files: [{ path: 'a.txt', status: 'M', additions: 2, deletions: 0 }] };
  await render(earlier, true);
  await answer({ ...changed, snapshotKind: 'scoped', checkpointId: 'turn-1' });
  assert.equal(bar(), null);

  await render([...earlier, edit('current')], true);
  await answer({ ...changed, checkpointId: 'turn-2' });
  assert.ok(bar(), "the current turn's own review shows");
});

test('a review tag is only sent while the review it names is still cached', async (t) => {
  const { render, answer, requests } = mount(t);
  const tagged = { kind: 'user', id: 'tagged', text: 'Tagged' };
  const etag = 'a'.repeat(32);
  await render([tagged, edit('first')], true);
  await answer({ etag });
  await render([tagged, edit('first'), edit('second')], true);
  assert.equal(requests.at(-1).args[0].known, etag);
  await answer({ etag });

  _runIdleReclaimForTest();
  await render([tagged, edit('first'), edit('second'), edit('third')], true);
  assert.equal(requests.at(-1).args[0].known, undefined, 'a dropped review is read in full again');
  await answer();
});
