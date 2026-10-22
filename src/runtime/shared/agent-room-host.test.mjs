import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAgentRoomHost, sendAgentRoomMessage, stopAgentRoom } from './agent-room-host.mjs';

const ROOM = 'sess_room_release1';

function fixture(t, name, calls, overrides = {}) {
  const host = {
    hasRoom: async (id) => id === ROOM,
    isRunning: () => false,
    send: async (...args) => {
      calls.push([name, 'send', ...args]);
      return true;
    },
    stop: (...args) => {
      calls.push([name, 'stop', ...args]);
      return false;
    },
    ...overrides,
  };
  const unregister = registerAgentRoomHost(host);
  t.after(unregister);
  return { host, unregister };
}

test('an idle room uses the newest matching host; bundle copies share registration and cleanup', async (t) => {
  const calls = [];
  fixture(t, 'old', calls);
  const current = fixture(t, 'current', calls);
  fixture(t, 'other profile', calls, { hasRoom: async () => false });
  const bundled = await import('./agent-room-host.mjs?desktop-bundle');
  assert.equal(await bundled.sendAgentRoomMessage(ROOM, 'hello'), true);
  assert.deepEqual(calls, [['current', 'send', ROOM, 'hello', {}]]);
  current.unregister();
  current.unregister();
  await stopAgentRoom(ROOM);
  assert.deepEqual(calls.at(-1), ['old', 'stop', ROOM]);
});

test('send and cancel reach the running owner even when a newer host is idle', async (t) => {
  const calls = [];
  fixture(t, 'running', calls, {
    isRunning: () => true,
    stop: () => {
      calls.push(['stopped running']);
      return true;
    },
  });
  fixture(t, 'new idle', calls);
  const source = { sender: { agentId: 'lead', name: 'Mixy' }, hop: 2 };
  await sendAgentRoomMessage(ROOM, '/ask reviewer review', source);
  assert.equal(await stopAgentRoom(ROOM), true);
  assert.deepEqual(calls, [['running', 'send', ROOM, '/ask reviewer review', source], ['stopped running']]);
});

test('ownership is checked after records load and an unregistered host is not called', async (t) => {
  const calls = [];
  let active = false;
  fixture(t, 'old', calls, { isRunning: () => active });
  const loaded = Promise.withResolvers();
  const checking = Promise.withResolvers();
  const current = fixture(t, 'new', calls, {
    hasRoom: async () => {
      checking.resolve();
      await loaded.promise;
      return true;
    },
  });
  const sent = sendAgentRoomMessage(ROOM, 'request');
  await checking.promise;
  active = true;
  current.unregister();
  loaded.resolve();
  await sent;
  assert.deepEqual(calls, [['old', 'send', ROOM, 'request', {}]]);
});

for (const alreadyRunning of [false, true]) {
  test(`cancel stops a current member and any later accepted intake (running: ${alreadyRunning})`, async (t) => {
    const calls = [];
    const entered = Promise.withResolvers();
    const accepted = Promise.withResolvers();
    let running = alreadyRunning;
    fixture(t, 'accepting', calls, {
      isRunning: () => running,
      send: async () => {
        entered.resolve();
        await accepted.promise;
        running = true;
        return true;
      },
      stop: () => {
        calls.push(['stop', running]);
        const aborted = running;
        running = false;
        return aborted;
      },
    });
    const sent = sendAgentRoomMessage(ROOM, 'request');
    await entered.promise;
    fixture(t, 'new idle', calls);
    const cancelled = stopAgentRoom(ROOM);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(running, false, 'the current member stops without waiting for intake');
    assert.deepEqual(calls, [['stop', alreadyRunning]]);
    accepted.resolve();
    assert.equal(await sent, true);
    assert.equal(await cancelled, true);
    assert.equal(running, false);
    assert.deepEqual(calls, [
      ['stop', alreadyRunning],
      ['stop', true],
    ]);
  });
}

test('missing, ambiguous and unreadable ownership fail without dispatch', async (t) => {
  await assert.rejects(sendAgentRoomMessage(ROOM, 'hello'), /controller is unavailable/);
  await assert.rejects(stopAgentRoom(ROOM), /controller is unavailable/);
  const calls = [];
  const first = fixture(t, 'one', calls, { isRunning: () => true });
  const second = fixture(t, 'two', calls, { isRunning: () => true });
  await assert.rejects(sendAgentRoomMessage(ROOM, 'hello'), /multiple active hosts/);
  await assert.rejects(stopAgentRoom(ROOM), /multiple active hosts/);
  first.unregister();
  second.unregister();
  fixture(t, 'unreadable', calls, {
    hasRoom: async () => {
      throw new Error('room records unreadable');
    },
  });
  await assert.rejects(sendAgentRoomMessage(ROOM, 'hello'), /room records unreadable/);
  assert.deepEqual(calls, []);
});
