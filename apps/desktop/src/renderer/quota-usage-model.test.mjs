import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaPercent } from './quota-usage-model.ts';

test('quota percentages round to whole numbers at every usage level', () => {
  for (const [value, expected] of [
    [0, '0%'],
    [0.3, '0%'],
    [0.49, '0%'],
    [0.5, '1%'],
    [2, '2%'],
    [2.4, '2%'],
    [2.5, '3%'],
    [2.6, '3%'],
    [9.9, '10%'],
    [10.4, '10%'],
    [10.5, '11%'],
    [99.6, '100%'],
    [100, '100%'],
    ['2.6', '3%'],
  ]) {
    assert.equal(quotaPercent(value), expected, String(value));
  }
});

test('unavailable quota percentages remain unavailable', () => {
  for (const value of [null, undefined, '', NaN, Infinity, 'invalid']) {
    assert.equal(quotaPercent(value), '—', String(value));
  }
});
