import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { DesktopStateBridge } from './ipc-state-bridge.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';

function bridgeWithLateFrames() {
  const handlers = new Map();
  const deliveries = [];
  const decoder = createSnapshotDeltaDecoder();
  let publish = () => {};
  const bridge = new DesktopStateBridge({
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: {},
        send(channel, value) {
          if (channel !== DESKTOP_IPC.sessionState) return;
          const received = structuredClone(value);
          deliveries.push({ ...received, snapshot: decoder.decode(received.wire).snapshot });
        },
      },
    },
    host: {
      subscribe: () => () => {},
      subscribeSessionStates(listener) {
        publish = listener;
        return () => {};
      },
      getSnapshot: () => ({}),
      setVisibleSessions: async () => true,
      // The reply resolves before the daemon's stream delivers the frame.
      prefetchSession: async () => true,
    },
    ipcMain: new EventEmitter(),
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  const frame = (sessionId, readTraceId) => ({
    sessionId,
    readTraceId,
    frameSource: 'read',
    snapshot: { sessionId, items: [{ id: 'answer', kind: 'assistant', text: 'loaded' }], queued: [] },
  });
  return { bridge, handlers, deliveries, publish: (update) => publish(update), frame };
}

test("a requested read's frame reaches the window even when it lands after the read's reply", async (t) => {
  const f = bridgeWithLateFrames();
  t.after(() => f.bridge.dispose());
  assert.equal(await f.handlers.get(DESKTOP_IPC.prefetchSession)({}, 'late', undefined, 'read-late'), true);
  f.publish(f.frame('late', 'read-late'));
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].readTraceId, 'read-late');
  assert.equal(f.deliveries[0].snapshot.items[0].text, 'loaded');
});

test('a late frame is admitted once, and only for the session and read the window asked for', async (t) => {
  const f = bridgeWithLateFrames();
  t.after(() => f.bridge.dispose());
  await f.handlers.get(DESKTOP_IPC.prefetchSession)({}, 'asked', undefined, 'read-asked');
  f.publish(f.frame('other', 'read-asked'));
  f.publish(f.frame('asked', 'read-unknown'));
  assert.equal(f.deliveries.length, 0, 'another session or another read stays hidden');
  f.publish(f.frame('asked', 'read-asked'));
  f.publish({ ...f.frame('asked', 'read-asked'), snapshot: { sessionId: 'asked', items: [], queued: [] } });
  assert.equal(f.deliveries.length, 1, 'the trace is consumed by its first frame');
});
