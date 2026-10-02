import test from 'node:test';
import assert from 'node:assert/strict';
import { formattedDateText } from './portable-xlsx-cell-values.mjs';

test('a date serial reads as its date format shows it; a number format is not a date', () => {
  assert.equal(formattedDateText(46174, 'm"월"'), '6월');
  assert.equal(formattedDateText(46174, 'yyyy-mm'), '2026-06');
  assert.equal(formattedDateText(46174, 'yyyy-mm-dd'), '2026-06-01');
  assert.equal(formattedDateText(46174, 'mmm yy'), 'Jun 26');
  assert.equal(formattedDateText(46174, '#,##0'), null);
  assert.equal(formattedDateText(46174, '0"분"'), null);
  assert.equal(formattedDateText(46174, 'h:mm'), null);
});
