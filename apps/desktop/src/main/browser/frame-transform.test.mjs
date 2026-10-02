import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BROWSER_FRAME_HAS_TRANSFORM } from './frame-transform.ts';
import { createBrowserRefPoints } from './ref-points.ts';

test('frame transform detection includes ancestors and shadow hosts', () => {
  const dom = new JSDOM('<div id="host"><iframe></iframe></div>', { runScripts: 'outside-only' });
  try {
    const check = dom.window.eval(`(${BROWSER_FRAME_HAS_TRANSFORM})`);
    const host = dom.window.document.querySelector('#host');
    const frame = host.querySelector('iframe');
    assert.equal(check(frame), false);
    host.style.transform = 'scale(0.6)';
    assert.equal(check(frame), true);
    host.style.transform = 'none';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(frame);
    assert.equal(check(frame), false);
    host.style.transform = 'rotate(10deg)';
    assert.equal(check(frame), true);
  } finally {
    dom.window.close();
  }
});

test('an unsupported transformed frame is not misreported or retried as an overlay', async () => {
  const guest = {};
  let probes = 0;
  const points = createBrowserRefPoints({
    accessibilityRefs: new Map([[guest, { refs: new Map([['ref', { backendNodeId: 1 }]]) }]]),
    callAccessibilityRef: async () => {
      probes++;
      return { handled: true, value: { error: 'transformed-frame' } };
    },
    captureSnapshotPayload: async () => assert.fail('do not look for a nonexistent overlay'),
  });
  await assert.rejects(points.resolveRefPoint(guest, 'ref'), /transformed parent frame.*not dispatched/);
  assert.equal(probes, 1);
});
