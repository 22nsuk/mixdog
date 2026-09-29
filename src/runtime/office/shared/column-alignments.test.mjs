import test from 'node:test';
import assert from 'node:assert/strict';
import { figureColumnAlignments } from './column-alignments.mjs';

// A column of figures sets right, words left; amounts with a currency or a Korean unit, and percentage-point
// changes, are figures (a %p column set left beside its percentages in the round-7 survey PDF).
test('figure columns set right, including currency, units and percentage points', () => {
  const rows = [
    ['규모', '응답자', '생산성 유지', '이직 의향 감소', '예산', '메모'],
    ['300인 미만', '620', '81%', '22%p', '2.6억 원', '확인 필요'],
    ['1,000인 이상', '510', '79%', '+24%p', '₩600,000', '보류'],
  ];
  assert.deepEqual(figureColumnAlignments(rows, 6), ['left', 'right', 'right', 'right', 'right', 'left']);
  // A row label with a digit in it stays left; a declared alignment is kept.
  assert.deepEqual(
    figureColumnAlignments(
      [
        ['호', 'n'],
        ['1호', '3'],
        ['2호', '4'],
      ],
      2,
      ['center']
    ),
    ['center', 'right']
  );
});
