import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { parts, value, workspace } from './office-test-support.mjs';
import { expandFilledFormulas, filledFormula } from './portable/xlsx-contract.mjs';
import { translateSharedFormula } from './portable/xlsx-formula-engine.mjs';

test('a formula filled over a range moves as Excel fills it', () => {
  const formula = '=SUMIFS(Ops[처리량 (건)],Ops[월],$B6)+C$1&"[x]"+Data!B2';
  assert.equal(
    filledFormula(formula, 1, 1, translateSharedFormula),
    '=SUMIFS(Ops[처리량 (건)],Ops[월],$B7)+D$1&"[x]"+Data!C3'
  );
  const cells = expandFilledFormulas(
    [
      { op: 'set_cell', cell: 'A1', value: 1 },
      { op: 'set_formula', sheet: 'R', range: 'C6:C8', formula: '=B6*2' },
    ],
    translateSharedFormula
  );
  assert.deepEqual(
    cells.map((operation) => [operation.op, operation.cell, operation.formula ?? operation.value]),
    [
      ['set_cell', 'A1', 1],
      ['set_formula', 'C6', '=B6*2'],
      ['set_formula', 'C7', '=B7*2'],
      ['set_formula', 'C8', '=B8*2'],
    ]
  );
});

test('the review reads a header set left over figures and an unmarked total row', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'review.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B4',
            values: [
              ['월', '처리량'],
              ['2026-06-01', 100],
              ['2026-07-01', 120],
              ['합계', 220],
            ],
          },
          { op: 'set_style', range: 'A1:B1', properties: { bold: true } },
          { op: 'set_style', range: 'B1:B4', properties: { horizontalAlignment: 'right' } },
        ],
      },
      { cwd }
    )
  );
  const found = JSON.stringify(value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })));
  assert.match(found, /header_alignment_mismatch[^}]*cell\[A1\]/, 'the month header sits left over its dates');
  assert.doesNotMatch(found, /header_alignment_mismatch[^}]*cell\[B1\]/, 'a right-set header over figures is fine');
  assert.match(found, /total_row_unmarked/);
});

test('set_formula range and a quiet, highlighted chart reach the workbook', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'report.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B5',
            values: [
              ['월', '대기 (분)'],
              ['6월', 52],
              ['7월', 34],
              ['8월', 19],
              ['9월', 15],
            ],
          },
          { op: 'set_range', range: 'C1', values: [['두 배']] },
          { op: 'set_formula', range: 'C2:C5', formula: '=B2*2' },
          {
            op: 'add_chart',
            range: 'A1:B5',
            cell: 'E2',
            chartType: 'column',
            seriesColors: ['1F5E4B'],
            highlight: '9월',
            gridlines: false,
            valueAxis: false,
            showValues: true,
            fontName: 'Malgun Gothic',
          },
        ],
      },
      { cwd }
    )
  );
  await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
  const book = await parts(path);
  const sheet = await book.text('xl/worksheets/sheet1.xml');
  for (const [cell, formula] of [
    ['C2', 'B2\\*2'],
    ['C5', 'B5\\*2'],
  ]) {
    assert.match(sheet, new RegExp(`<c r="${cell}"[^>]*><f>${formula}</f>`));
  }
  const chart = await book.text('xl/charts/chart1.xml');
  assert.doesNotMatch(chart, /<c:majorGridlines/, 'no gridlines');
  assert.match(chart, /<c:valAx>[\s\S]*?<c:delete val="1"\/>/, 'the value axis is deleted');
  const points = [...chart.matchAll(/<c:dPt><c:idx val="(\d)"\/>[\s\S]*?<a:srgbClr val="([0-9A-F]{6})"\/>/g)].map(
    (match) => [Number(match[1]), match[2]]
  );
  assert.deepEqual(points, [
    [0, 'C9CED6'],
    [1, 'C9CED6'],
    [2, 'C9CED6'],
    [3, '1F5E4B'],
  ]);
  assert.match(chart, /<a:latin typeface="Malgun Gothic"\/>/);
});
