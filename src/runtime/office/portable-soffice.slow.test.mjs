// The portable conversion path keeps one LibreOffice user profile for the life
// of the process and runs conversions through it in order. These drive real
// LibreOffice runs, so they sit in the slow lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool } from './index.mjs';
import {
  convertLegacyOffice,
  libreOfficeAvailable,
  recalculateLibreOfficeWorkbook,
  renderPortableOoxml,
  validateLibreOfficeReopen,
} from './portable/portable-soffice.mjs';
import { value, workspace } from './office-test-support.mjs';

const RENDERED = { skip: !(await libreOfficeAvailable()) && 'LibreOffice is not installed' };

// A killed or failed run can leave a lock behind in the profile it used, and a
// reused profile would hand that to everything after it. The failed conversion
// drops the profile instead, so the next render builds a clean one.
test('a failed conversion leaves the next render working', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'recovers.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '복구 확인' }],
      },
      { cwd }
    )
  );
  await assert.rejects(() => renderPortableOoxml(join(cwd, 'absent.docx'), join(cwd, 'absent.pdf')));
  const details = await stat(await renderPortableOoxml(source, join(cwd, 'after.pdf')));
  assert.ok(details.isFile() && details.size > 0);
});

// LibreOffice writes its output under the source's own name, so overlapping
// runs would fight over the same intermediate file, and a shared profile would
// refuse the second process. Both renders must still finish.
test('concurrent portable renders both produce a PDF through the shared profile', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'queued.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '대기열 렌더링' }],
      },
      { cwd }
    )
  );
  const outputs = [join(cwd, 'first.pdf'), join(cwd, 'second.pdf')];
  const rendered = await Promise.all(outputs.map((output) => renderPortableOoxml(source, output)));
  assert.deepEqual(rendered, outputs);
  for (const output of outputs) {
    const details = await stat(output);
    assert.ok(details.isFile() && details.size > 0, output);
  }
});

// LibreOffice names what it converts after the source it read, minus the
// source's own extension: a document named `reopen.check.docx` comes back as
// `reopen.check.pdf`. Every caller finds its output by rebuilding that name,
// and a wrong name reads as "LibreOffice produced nothing".
test('a reopen validation finds the PDF named after the source', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'reopen.check.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [{ op: 'append_text', text: '재열기 확인' }],
      },
      { cwd }
    )
  );
  const reopened = await validateLibreOfficeReopen(source);
  assert.equal(reopened.available, true);
  assert.equal(reopened.opened, true);
  assert.equal(reopened.backend, 'libreoffice');
  assert.ok(reopened.outputBytes > 0);
});

test('a recalculation reads back the workbook named after the source', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'recalculate.check.xlsx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
          { op: 'set_formula', cell: 'B4', formula: '=SUM(B2:B3)' },
        ],
      },
      { cwd }
    )
  );
  const recalculated = await recalculateLibreOfficeWorkbook(source, { force: true });
  assert.equal(recalculated.available, true);
  assert.equal(recalculated.recalculated, true);
  assert.ok(recalculated.outputBytes > 0);
});

// The roundtrip is asked for values alone. Kept whole, LibreOffice's copy put its own style table under the cells —
// a Batang title came back in Malgun Gothic and the Malgun Gothic cells beside it in Batang — and its own chart. The
// chart's copy of its cells is the one part that follows the values: written before them, its formula column held 0.
test(
  'a recalculation carries the computed values into the workbook as authored and changes nothing else',
  RENDERED,
  async (t) => {
    const cwd = await workspace(t);
    const source = join(cwd, 'recalculate.faces.xlsx');
    value(
      await executeOfficeTool(
        {
          action: 'create',
          path: source,
          mode: 'portable',
          operations: [
            { op: 'set_cell', cell: 'A1', value: '야간 처리량' },
            { op: 'set_style', range: 'A1', properties: { fontName: 'Batang', fontSize: 22 } },
            {
              op: 'set_range',
              range: 'A2:B4',
              values: [
                ['권역', '처리량'],
                ['수도권', 82400],
                ['부산', 71600],
              ],
            },
            { op: 'set_cell', cell: 'C2', value: '목표' },
            { op: 'set_formula', cell: 'C3', formula: '=B3*2' },
            { op: 'set_formula', cell: 'C4', formula: '=B4*2' },
            { op: 'set_style', range: 'A2:C4', properties: { fontName: 'Malgun Gothic', fontSize: 10 } },
            { op: 'add_chart', chartType: 'column', range: 'A2:C4', cell: 'E2' },
          ],
        },
        { cwd }
      )
    );
    const text = async (zip, name) => await zip.file(name).async('string');
    const before = await JSZip.loadAsync(await readFile(source));
    assert.doesNotMatch(await text(before, 'xl/worksheets/sheet1.xml'), /<v>164800<\/v>/, 'written without values');
    const recalculated = await recalculateLibreOfficeWorkbook(source, { force: true });
    assert.equal(recalculated.recalculated, true);
    const after = await JSZip.loadAsync(await readFile(source));
    assert.match(
      await text(after, 'xl/worksheets/sheet1.xml'),
      /<c r="C3"[^>]*><f>[^<]*<\/f><v>164800<\/v><\/c>/,
      'the formula carries its value'
    );
    assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort(), 'no part added or dropped');
    const chartBefore = await text(before, 'xl/charts/chart1.xml');
    const chartAfter = await text(after, 'xl/charts/chart1.xml');
    const withoutCaches = (xml) => xml.replace(/<c:(num|str)Cache>[\s\S]*?<\/c:\1Cache>/g, '');
    assert.equal(withoutCaches(chartAfter), withoutCaches(chartBefore), 'the chart is the one authored');
    assert.match(
      chartAfter,
      /<c:f>Sheet1!\$C\$3:\$C\$4<\/c:f><c:numCache>(?:(?!<\/c:numCache>)[\s\S])*<c:v>164800<\/c:v>/,
      'its copy of the formula column holds the values'
    );
    for (const entry of Object.values(before.files)) {
      if (entry.dir || /^xl\/(?:worksheets\/sheet\d+|workbook|charts\/chart\d+)\.xml$/.test(entry.name)) continue;
      assert.equal(await text(after, entry.name), await entry.async('string'), entry.name);
    }
  }
);

// A legacy binary file is saved once as its package beside the original, and
// the session reads that package. The same open a second time is sent to the
// converted file instead of overwriting it.
test('open converts a legacy binary file beside it and never overwrites the result', RENDERED, async (t) => {
  const cwd = await workspace(t);
  const cases = [
    {
      seed: 'seed.docx',
      legacy: 'report.doc',
      converted: 'report.docx',
      operations: [{ op: 'append_text', text: '레거시 문서 본문' }],
      expected: '레거시 문서 본문',
    },
    {
      seed: 'seed.xlsx',
      legacy: 'ledger.xls',
      converted: 'ledger.xlsx',
      operations: [
        {
          op: 'set_range',
          range: 'A1:B2',
          values: [
            ['지역', '매출'],
            ['서울', 120],
          ],
        },
      ],
      expected: '서울',
    },
  ];
  for (const { seed, legacy, converted, operations, expected } of cases) {
    value(await executeOfficeTool({ action: 'create', path: join(cwd, seed), mode: 'portable', operations }, { cwd }));
    await convertLegacyOffice(join(cwd, seed), join(cwd, legacy));

    const opened = value(await executeOfficeTool({ action: 'open', path: legacy, mode: 'portable' }, { cwd }));
    assert.equal(opened.convertedFrom, join(cwd, legacy));
    assert.ok((await stat(join(cwd, converted))).size > 0, converted);
    assert.match(JSON.stringify(opened), new RegExp(expected));
    value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));

    const again = await executeOfficeTool({ action: 'open', path: legacy, mode: 'portable' }, { cwd });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /already exists; open .+ directly/);
  }

  // A deck: the bundled template stands in for the seed.
  const template = new URL('./design/library/templates/mixdog-executive.pptx', import.meta.url);
  await copyFile(template, join(cwd, 'seed.pptx'));
  await convertLegacyOffice(join(cwd, 'seed.pptx'), join(cwd, 'deck.ppt'));
  const deck = value(await executeOfficeTool({ action: 'open', path: 'deck.ppt', mode: 'portable' }, { cwd }));
  assert.equal(deck.convertedFrom, join(cwd, 'deck.ppt'));
  assert.ok((await stat(join(cwd, 'deck.pptx'))).size > 0);
  value(await executeOfficeTool({ action: 'close', session: deck.session }, { cwd }));
});
