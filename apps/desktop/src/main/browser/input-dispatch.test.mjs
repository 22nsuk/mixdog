import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDispatch } from './input-dispatch.ts';

test('offscreen child-frame input uses child coordinates and rechecks local ownership at dispatch', async () => {
  const sent = [];
  let current = true;
  const dispatch = createBrowserInputDispatch({
    documentId: () => 'document',
    frames: () => new Map([['child-session', { frameId: 'child-frame' }]]),
    frameOffset: async () => ({ x: 100, y: 200 }),
    cdp: {
      call: async (_guest, _method, params) => {
        assert.equal(params.x, 120);
        assert.equal(params.y, 230);
        return { frameId: 'child-frame' };
      },
      guestDebugger: async () => ({}),
      sendCdpInput: async (_guest, _cdp, method, params, _signal, session, guard) => {
        guard?.();
        sent.push({ method, params, session });
        return 'completed';
      },
    },
  });
  const input = { type: 'mousePressed', x: 120.25, y: 230.25 };
  const guard = () => {
    if (!current) throw new Error('document changed');
  };
  await dispatch(
    { isOffscreen: () => true, getZoomFactor: () => 1 },
    'Input.dispatchMouseEvent',
    input,
    undefined,
    guard
  );
  assert.deepEqual(sent, [
    {
      method: 'Input.dispatchMouseEvent',
      params: { ...input, x: 20.25, y: 30.25 },
      session: 'child-session',
    },
  ]);
  current = false;
  await assert.rejects(
    dispatch({ isOffscreen: () => true, getZoomFactor: () => 1 }, 'Input.dispatchMouseEvent', input, undefined, guard),
    /document changed/
  );
  assert.equal(sent.length, 1);
});

test('emulated input compensates host zoom without scaling normal desktop CSS coordinates', async () => {
  for (const layoutZoom of [0.75, 1]) {
    const sent = [];
    const guest = { getZoomFactor: () => 0.75 };
    const dispatch = createBrowserInputDispatch({
      documentId: () => 'document',
      frames: () => new Map(),
      cdp: {
        call: async (_guest, method) => {
          assert.equal(method, 'Page.getLayoutMetrics');
          return { cssVisualViewport: { zoom: layoutZoom } };
        },
        guestDebugger: async () => ({}),
        sendCdpInput: async (_guest, _cdp, _method, input, _signal, _session, guard) => {
          guard();
          sent.push(input);
          return 'completed';
        },
      },
    });
    await dispatch(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 225 });
    await dispatch(guest, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 225, id: 0 }] });
    const expected = layoutZoom === 1 ? { x: 200, y: 300 } : { x: 150, y: 225 };
    assert.deepEqual(sent[0], { type: 'mousePressed', ...expected });
    assert.deepEqual(sent[1].touchPoints, [{ ...expected, id: 0 }]);
  }
});
