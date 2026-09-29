import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { defaultTraceFiles, field, num, payload, sessionId } from './trace-row.mjs';

test('defaultTraceFiles: an explicit path wins, a data dir yields its rotated pair', () => {
  assert.deepEqual(defaultTraceFiles({ pathArg: 'x.jsonl' }), [resolve('x.jsonl')]);
  assert.deepEqual(defaultTraceFiles({ dataDir: 'd' }), [
    resolve('d', 'history', 'agent-trace.jsonl.1'),
    resolve('d', 'history', 'agent-trace.jsonl'),
  ]);
});

test('defaultTraceFiles without arguments covers the project and user data dirs, deduplicated', () => {
  const files = defaultTraceFiles();
  assert.equal(files.length, new Set(files).size);
  assert.ok(files.includes(resolve(process.cwd(), '.mixdog', 'data', 'history', 'agent-trace.jsonl')));
});

test('payload is the row payload object, else an empty object', () => {
  assert.deepEqual(payload({ payload: { a: 1 } }), { a: 1 });
  assert.deepEqual(payload({ payload: 'text' }), {});
  assert.deepEqual(payload(null), {});
});

test('field prefers the row itself, falls back to the payload, else null', () => {
  assert.equal(field({ a: 1, payload: { a: 2 } }, 'a'), 1);
  assert.equal(field({ payload: { a: 2 } }, 'a'), 2);
  assert.equal(field({ a: null, payload: { a: 3 } }, 'a'), 3);
  assert.equal(field({}, 'a'), null);
  assert.equal(field(undefined, 'a'), null);
});

test('num coerces the field and drops non-finite values', () => {
  assert.equal(num({ payload: { n: '12' } }, 'n'), 12);
  assert.equal(num({ n: 'x' }, 'n'), null);
  // A missing field reads as Number(null) === 0, not null (existing behavior
  // of every trace CLI that used its own copy).
  assert.equal(num({}, 'n'), 0);
});

test('sessionId reads either spelling, then the payload, as a string', () => {
  assert.equal(sessionId({ session_id: 's1' }), 's1');
  assert.equal(sessionId({ sessionId: 's2' }), 's2');
  assert.equal(sessionId({ payload: { session_id: 's3' } }), 's3');
  assert.equal(sessionId({}), '');
});
