import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration, summarize } from './smoke-loop-shared.mjs';

test('parseDuration reads bare milliseconds and unit suffixes', () => {
  assert.equal(parseDuration('1500'), 1500);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5M'), 300_000);
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('0ms'), 1);
});

test('parseDuration returns the fallback when empty and throws on garbage', () => {
  assert.equal(parseDuration('', 7), 7);
  assert.equal(parseDuration(undefined), null);
  assert.throws(() => parseDuration('soon'), /invalid duration: soon/);
});

test('summarize rounds min/max/avg to one decimal, zeros when empty', () => {
  assert.deepEqual(summarize([]), { min: 0, max: 0, avg: 0 });
  assert.deepEqual(summarize([1.04, 2.06, 3.31]), { min: 1, max: 3.3, avg: 2.1 });
});
