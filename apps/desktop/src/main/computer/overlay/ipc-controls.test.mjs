import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerOverlayController } from './controls.ts';
import { bindComputerOverlayControls } from './ipc-controls.ts';
import { readComputerRunRecords } from '../session/run-log.ts';

function fixture(controls, presentation = { sessionIds: ['a'], generation: 1 }) {
  const handlers = new Map();
  const contents = { ipc: { handle: (channel, handler) => handlers.set(channel, handler) }, mainFrame: {} };
  const controller = createComputerOverlayController(controls, () => {});
  bindComputerOverlayControls(contents, controller, controls, () => presentation);
  return (request) =>
    handlers.get('computer-overlay-control')({ sender: contents, senderFrame: contents.mainFrame }, request);
}

test('every Stop press leaves a record, so a press that did nothing is still evidence it arrived', async () => {
  const invoke = fixture({
    stop: async () => {
      throw new Error('computer_stop_unconfirmed: agent turn cancellation failed');
    },
  });
  assert.deepEqual(await invoke({ action: 'stop', generation: 1 }), { accepted: true, busy: false, error: 'stop' });
  const [record] = readComputerRunRecords('a', 20)
    .filter((entry) => entry.action === 'overlay_stop')
    .slice(-1);
  assert.deepEqual([record.generation, record.ok, record.error], [1, true, 'stop']);
});

test('a pointer press is recorded without invoking any control', async () => {
  const calls = [];
  const invoke = fixture({
    pause: async () => calls.push('pause'),
    stop: async () => calls.push('stop'),
  });
  assert.deepEqual(await invoke({ action: 'press', control: 'stop' }), { accepted: true });
  for (const control of ['resume', 'other']) {
    await assert.rejects(invoke({ action: 'press', control }), /Invalid overlay request/);
  }
  const [record] = readComputerRunRecords('a', 20)
    .filter((entry) => entry.action === 'overlay_press')
    .slice(-1);
  assert.deepEqual([record.control, record.generation], ['stop', 1]);
  assert.deepEqual(calls, []);
});

test('Stop is the only control the overlay accepts', async () => {
  const calls = [];
  const invoke = fixture({
    pause: async () => calls.push('pause'),
    stop: async () => calls.push('stop'),
  });
  assert.deepEqual(await invoke({ action: 'stop', generation: 1 }), { accepted: true, busy: false, error: '' });
  // Pausing belongs to the user's own input; that pause resumes by itself or ends with Stop.
  for (const action of ['resume', 'pause']) {
    await assert.rejects(invoke({ action, generation: 1 }), /Invalid overlay request/);
  }
  assert.deepEqual(calls, ['stop']);
});
