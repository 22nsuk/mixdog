import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startRemoteRelay } from './remote-relay.ts';

test('a dispatch failure on a relay message ends the leg instead of an unhandled rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-dispatch-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const none = () => () => {};
  const host = {
    getSnapshot: () => ({ sessionId: 'session', items: [], status: 'idle' }),
    listSessions: async () => [],
    listAgentPool: async () => [],
    subscribe: none,
    subscribeSessions: none,
    subscribeAgentPool: none,
    subscribeSessionStates: none,
    subscribeDesktopEvents: none,
    setVisibleSessionsForSource: async () => true,
    invokeDesktopOperation: async () => null,
  };
  let handle;
  let failing = true;
  try {
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`,
      userDataPath: dir,
      host,
      onClientCountChanged: () => {
        // Fail only the dispatch; the close handler's own notification passes.
        if (failing) {
          failing = false;
          throw new Error('fixture dispatch failure');
        }
      },
    });
    const [socket] = await connected;
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'client-open', clientId: 'client-a' }));
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await handle?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
