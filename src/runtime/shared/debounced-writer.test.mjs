import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebouncedWriter } from './debounced-writer.mjs';
import { waitUntil } from './wait-until.test-support.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('a debounce burst writes only its last value', async () => {
  const writes = [];
  const writer = createDebouncedWriter({
    write: async (value) => writes.push(value),
    onError: assert.fail,
    delayMs: 5,
  });
  writer.schedule('first');
  writer.schedule('last');
  await waitUntil(() => writes.length > 0 && !writer.hasPending(), { message: 'debounced write landed' });
  assert.deepEqual(writes, ['last']);
});

test('overlapping flushes share a drain and serialize newer pending values', async () => {
  const first = deferred();
  const writes = [];
  const writer = createDebouncedWriter({
    write: async (value) => {
      writes.push(value);
      if (value === 'first') await first.promise;
    },
    onError: assert.fail,
    delayMs: 1000,
  });
  writer.schedule('first');
  const flushed = writer.flush();
  await waitUntil(() => writes.length === 1, { message: 'first write started' });
  writer.schedule('last');
  assert.equal(writer.flush(), flushed);
  assert.deepEqual(writes, ['first']);
  first.resolve();
  await flushed;
  assert.deepEqual(writes, ['first', 'last']);
});

test('failed writes retain the latest value without a hot retry loop', async () => {
  const failure = new Error('disk unavailable');
  const errors = [];
  const writes = [];
  let failing = true;
  const writer = createDebouncedWriter({
    write: async (value) => {
      writes.push(value);
      if (failing) throw failure;
    },
    onError: (error) => errors.push(error),
    delayMs: 1000,
  });
  writer.schedule('keep');
  assert.equal(await writer.flush(), false);
  assert.equal(writer.getPending(), 'keep');
  assert.deepEqual(writes, ['keep']);
  assert.deepEqual(errors, [failure]);
  failing = false;
  assert.equal(await writer.flush(), true);
  assert.deepEqual(writes, ['keep', 'keep']);
  assert.equal(writer.hasPending(), false);
});

test('synchronous flush never overtakes an asynchronous writer', async () => {
  const first = deferred();
  const writes = [];
  let started = false;
  const writer = createDebouncedWriter({
    write: async (value) => {
      started = true;
      await first.promise;
      writes.push(value);
    },
    onError: assert.fail,
    delayMs: 1000,
  });
  writer.schedule('old');
  const flushed = writer.flush();
  await waitUntil(() => started, { message: 'old write started' });
  writer.schedule('new');
  assert.equal(
    writer.flushSyncIfIdle((value) => writes.push(value)),
    false
  );
  assert.deepEqual(writes, []);
  first.resolve();
  await flushed;
  assert.deepEqual(writes, ['old', 'new']);
});

test('synchronous failures retain pending work for a later asynchronous flush', async () => {
  const failure = new Error('lock busy');
  const errors = [];
  const writes = [];
  const writer = createDebouncedWriter({
    write: async (value) => writes.push(value),
    onError: (error, sync) => errors.push([error, sync]),
    delayMs: 1000,
  });
  writer.schedule('keep');
  assert.equal(
    writer.flushSyncIfIdle(() => {
      throw failure;
    }),
    false
  );
  assert.equal(writer.getPending(), 'keep');
  await writer.flush();
  assert.deepEqual(errors, [[failure, true]]);
  assert.deepEqual(writes, ['keep']);
});

test('a completed write cannot clear a same-value update queued while it was running', async () => {
  const first = deferred();
  const writes = [];
  const value = { setting: 'old' };
  const writer = createDebouncedWriter({
    write: async (next) => {
      writes.push({ ...next });
      if (writes.length === 1) await first.promise;
    },
    onError: assert.fail,
    delayMs: 1000,
  });
  writer.schedule(value);
  const flushed = writer.flush();
  await waitUntil(() => writes.length === 1, { message: 'first write started' });
  value.setting = 'new';
  writer.schedule(value);
  first.resolve();
  await flushed;
  assert.deepEqual(writes, [{ setting: 'old' }, { setting: 'new' }]);
});

for (const synchronous of [false, true]) {
  test(`${synchronous ? 'a synchronous' : 'an asynchronous'} flush accepts work queued by a completed write's observer`, async () => {
    const first = deferred();
    const writes = [];
    const writer = createDebouncedWriter({
      write: (value) => {
        writes.push(value);
        return value === 'first' ? first.promise : Promise.resolve();
      },
      onError: assert.fail,
      delayMs: 5,
    });
    writer.schedule('first');
    const flushed = writer.flush();
    await waitUntil(() => writes.length === 1, { message: 'first write started' });
    const observer = first.promise.then(async () => {
      writer.schedule('next');
      if (synchronous) writer.flushSyncIfIdle((value) => writes.push(value));
      else await writer.flush();
    });
    first.resolve();
    await Promise.all([flushed, observer]);
    // Even a deferred synchronous flush must retain its scheduled write.
    await waitUntil(() => writes.length === 2 && !writer.hasPending(), { message: 'retained write landed' });
    assert.deepEqual(writes, ['first', 'next']);
  });
}
