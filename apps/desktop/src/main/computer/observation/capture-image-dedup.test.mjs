import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptureImageDedupStore } from './capture-image-dedup.ts';
import { createCaptureAfter } from './capture-after.ts';

test('only an identical frame for the same target counts as a repeat', () => {
  const store = createCaptureImageDedupStore();
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'AAAA'), false);
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'AAAA'), true);
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'BBBB'), false);
  assert.equal(store.isRepeat('s1:hwnd:0x2', 'BBBB'), false);
  store.forget('s1:hwnd:0x1');
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'BBBB'), false);
});

test('a follow-up capture of an unchanged screen keeps its text and drops the duplicate image', async () => {
  const host = { assertExecutionNotAborted() {}, sessionIdFor: () => 's1' };
  const ocrPreferences = { resolve: () => ({ includeOcr: false }) };
  let captures = 0;
  const captureAfter = createCaptureAfter(host, ocrPreferences, async () => {
    captures += 1;
    return {
      payload: { ok: true, elements: captures },
      image: { mimeType: 'image/jpeg', data: 'SAME-PIXELS' },
    };
  });
  const command = { action: 'click', session_id: 's1' };
  const first = await captureAfter(command, 'hwnd:0x1', 0);
  assert.equal(first.image.data, 'SAME-PIXELS');
  assert.equal(first.metadata.image_unchanged, undefined);

  const second = await captureAfter(command, 'hwnd:0x1', 0);
  assert.equal(second.image, undefined);
  assert.equal(second.metadata.image_unchanged, true);
  // The text metadata is still a fresh read, not a replay.
  assert.equal(second.metadata.elements, 2);
});

test('a launch capture waits until two read-only reads of the new window agree', async () => {
  const layouts = [['Button:File'], ['Button:File', 'Button:Pencil'], ['Button:File', 'Button:Pencil']];
  const events = [];
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell(request) {
      assert.equal(request.action, 'window_predicates');
      assert.equal(request.read_only, true);
      const names = layouts.shift() ?? ['Button:File', 'Button:Pencil'];
      events.push(`read:${names.length}`);
      return { ok: true, result: { elements: names.map((name) => ({ role: name.split(':')[0], name })) } };
    },
  };
  const captureAfter = createCaptureAfter(host, { resolve: () => ({ includeOcr: false }) }, async () => {
    events.push('capture');
    return { payload: { ok: true } };
  });
  await captureAfter({ action: 'launch', session_id: 's1' }, 'hwnd:0x1', 0);
  // The partial first layout differs from the second, which the third repeats.
  assert.deepEqual(events, ['read:1', 'read:2', 'read:2', 'capture']);

  events.length = 0;
  await captureAfter({ action: 'click', session_id: 's1' }, 'hwnd:0x1', 0);
  assert.deepEqual(events, ['capture'], 'only a launch waits for its layout');
});

test('a ref-targeted act is observed through its tree unless that tree is unusable', async () => {
  const host = { assertExecutionNotAborted() {}, sessionIdFor: () => 's1' };
  const modes = [];
  let status = 'available';
  const captureAfter = createCaptureAfter(host, { resolve: () => ({ includeOcr: false }) }, async (command) => {
    modes.push(command.mode);
    return command.mode === 'ax'
      ? { payload: { ok: true, accessibility_status: status } }
      : { payload: { ok: true, accessibility_status: status }, image: { mimeType: 'image/jpeg', data: 'PIXELS' } };
  });
  const byRef = { action: 'sequence', session_id: 's1', steps: [{ action: 'click', ref: 's1:e0' }] };

  const semantic = await captureAfter(byRef, 'hwnd:0x1', 0);
  assert.deepEqual(modes, ['ax']);
  assert.equal(semantic.image, undefined);

  modes.length = 0;
  status = 'chrome_only';
  const fallback = await captureAfter(byRef, 'hwnd:0x1', 0);
  assert.deepEqual(modes, ['ax', 'state'], 'an unusable tree takes the full observation');
  assert.equal(fallback.image.data, 'PIXELS');

  modes.length = 0;
  await captureAfter({ ...byRef, capture_after_mode: 'ax' }, 'hwnd:0x1', 0);
  assert.deepEqual(modes, ['ax'], 'an explicit mode is never widened');

  modes.length = 0;
  status = 'available';
  await captureAfter({ action: 'sequence', session_id: 's1', steps: [{ action: 'click', x: 4, y: 4 }] }, 'hwnd:0x1', 0);
  await captureAfter({ action: 'key', session_id: 's1', keys: 'enter' }, 'hwnd:0x1', 0);
  assert.deepEqual(modes, ['state', 'state'], 'pixel-targeted and untargeted input keep the frame');
});
