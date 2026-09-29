import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { attachLineReader, frameLine } from './wire.mjs';

test('attachLineReader keeps multibyte characters split across chunks intact', async () => {
  const socket = new PassThrough();
  const frames = [];
  attachLineReader(socket, (frame) => frames.push(frame));
  const bytes = Buffer.from(frameLine({ t: 'full', text: '한글 세션' }));
  const cut = bytes.indexOf(Buffer.from('글')) + 1;
  socket.write(bytes.subarray(0, cut));
  await new Promise((resolve) => setImmediate(resolve));
  socket.write(bytes.subarray(cut));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(frames, [{ t: 'full', text: '한글 세션' }]);
});
