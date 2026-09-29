// Rows and columns inserted into and deleted from a Data sheet that the rest of the workbook names. The expected text
// is what Excel 16 wrote for the same workbook and the same edits (Office backend, read back from the saved file):
// the formulas on both sheets, the names and print area, the rule and validation ranges, the chart series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PNG_PIXEL } from '../office-test-support.mjs';
import { iterateSheetCells, workbookSheets } from './portable-cells.mjs';
import { zipText } from './portable-opc.mjs';
import { createPortableChartWorkbook } from './portable-package.mjs';
import { xmlDecode } from './portable-xml.mjs';
import { applyXlsx } from './portable-xlsx.mjs';

const DATA = [
  ['권역', '7월', '8월', '9월', '지연률', '가동률'],
  ['수도권', 26100, 27300, 29000, 0.009, 0.81],
  ['부산', 21400, 23800, 26400, 0.019, 0.94],
  ['호남', 9400, 10100, 10700, 0.011, 0.67],
  ['강원', 4100, 4300, 4600, 0.007, 0.58],
  ['제주', 2100, 2300, 2500, 0.013, 0.62],
];
const REPORT = [
  '=SUM(Data!D2:D6)',
  '=Data!A6',
  '=Data!$B$6+Data!B5',
  '=SUM(Data!6:6)',
  '=SUM(Data!C:C)',
  '=IF(Data!A6="Data!A6","same",Data!A6)',
  '=SUM(Sept)',
  '=SUM(Data!D6:D7)',
  '=COUNTA(Data!A1:F1)',
  '=SUM(Data!B2:D3)',
];

async function operationsWorkbook(sheetName = 'Data') {
  const zip = await JSZip.loadAsync(await createPortableChartWorkbook(DATA, { sheetName }));
  await applyXlsx(zip, [
    { op: 'add_sheet', name: 'Report' },
    ...[2, 3, 4, 5, 6].map((row) => ({
      op: 'set_formula',
      sheet: 'Data',
      cell: `G${row}`,
      formula: `=D${row}/B${row}-1`,
    })),
    { op: 'set_formula', sheet: 'Data', cell: 'D7', formula: '=SUM(D2:D6)' },
    {
      op: 'add_conditional_format',
      sheet: 'Data',
      range: 'D2:D6',
      formula: '$D2>AVERAGE($D$2:$D$6)',
      fillColor: 'FFF2CC',
    },
    { op: 'add_validation', sheet: 'Data', range: 'E2:E6', type: 'decimal', formula1: '0', formula2: '1' },
    { op: 'add_chart', sheet: 'Data', range: 'A1:A6,D1:D6', cell: 'I2', chartType: 'bar', title: '9월' },
    { op: 'set_page_setup', sheet: 'Data', printArea: 'A1:G7', printTitleRows: '1' },
    { op: 'define_name', name: 'Sept', refersTo: '=Data!$D$2:$D$6' },
    { op: 'define_name', name: 'Jeju', refersTo: '=Data!$A$6' },
    ...REPORT.map((formula, index) => ({ op: 'set_formula', sheet: 'Report', cell: `A${index + 1}`, formula })),
  ]);
  return zip;
}

async function sheetXml(zip, name) {
  const sheet = (await workbookSheets(zip)).find((entry) => entry.name === name);
  return await zipText(zip, sheet.path);
}

async function formulas(zip, name) {
  return [...iterateSheetCells(await sheetXml(zip, name))].flatMap((cell) => {
    const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(cell.body);
    return formula ? [`${cell.ref}=${xmlDecode(formula[1])}`] : [];
  });
}

async function workbookFacts(zip) {
  const data = await sheetXml(zip, 'Data');
  const workbook = await zipText(zip, 'xl/workbook.xml');
  const chart = await zipText(zip, 'xl/charts/chart1.xml');
  return {
    report: await formulas(zip, 'Report'),
    data: await formulas(zip, 'Data'),
    names: Object.fromEntries(
      [...workbook.matchAll(/<definedName\b[^>]*?\bname="([^"]+)"[^>]*>([^<]*)<\/definedName>/g)].map((match) => [
        match[1],
        xmlDecode(match[2]),
      ])
    ),
    conditionalFormats: [
      ...data.matchAll(/<conditionalFormatting sqref="([^"]+)">[\s\S]*?<formula>([^<]*)<\/formula>/g),
    ].map((match) => [match[1], xmlDecode(match[2])]),
    validations: [...data.matchAll(/<dataValidation\b[^>]*?\bsqref="([^"]+)"/g)].map((match) => match[1]),
    series: [...chart.matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((match) => xmlDecode(match[1])),
  };
}

const reportAfter = (texts) => texts.map((text, index) => `A${index + 1}=${text}`);

test('rows inserted inside a range Excel widens are written as Excel writes them, on every sheet and part', async () => {
  const zip = await operationsWorkbook();
  const [result] = await applyXlsx(zip, [{ op: 'insert_rows', sheet: 'Data', row: 6, count: 1 }]);
  assert.equal(result.referenceAware, true);
  const facts = await workbookFacts(zip);
  assert.deepEqual(
    facts.report,
    reportAfter([
      'SUM(Data!D2:D7)',
      'Data!A7',
      'Data!$B$7+Data!B5',
      'SUM(Data!7:7)',
      'SUM(Data!C:C)',
      'IF(Data!A7="Data!A6","same",Data!A7)',
      'SUM(Sept)',
      'SUM(Data!D7:D8)',
      'COUNTA(Data!A1:F1)',
      'SUM(Data!B2:D3)',
    ])
  );
  assert.deepEqual(facts.data, ['G2=D2/B2-1', 'G3=D3/B3-1', 'G4=D4/B4-1', 'G5=D5/B5-1', 'G7=D7/B7-1', 'D8=SUM(D2:D7)']);
  assert.deepEqual(facts.names, {
    Sept: 'Data!$D$2:$D$7',
    Jeju: 'Data!$A$7',
    '_xlnm.Print_Area': 'Data!$A$1:$G$8',
    '_xlnm.Print_Titles': 'Data!$1:$1',
  });
  assert.deepEqual(facts.conditionalFormats, [['D2:D7', '$D2>AVERAGE($D$2:$D$7)']]);
  assert.deepEqual(facts.validations, ['E2:E7']);
  assert.deepEqual(facts.series.slice(-2), ['Data!$A$2:$A$7', 'Data!$D$2:$D$7']);
});

test('deleted rows leave #REF! where Excel does and close the ranges they cut', async () => {
  const zip = await operationsWorkbook();
  await applyXlsx(zip, [{ op: 'delete_rows', sheet: 'Data', row: 6, count: 1 }]);
  const facts = await workbookFacts(zip);
  assert.deepEqual(
    facts.report,
    reportAfter([
      'SUM(Data!D2:D5)',
      'Data!#REF!',
      'Data!#REF!+Data!B5',
      'SUM(Data!#REF!)',
      'SUM(Data!C:C)',
      'IF(Data!#REF!="Data!A6","same",Data!#REF!)',
      'SUM(Sept)',
      'SUM(Data!D6:D6)',
      'COUNTA(Data!A1:F1)',
      'SUM(Data!B2:D3)',
    ])
  );
  assert.deepEqual(facts.data, ['G2=D2/B2-1', 'G3=D3/B3-1', 'G4=D4/B4-1', 'G5=D5/B5-1', 'D6=SUM(D2:D5)']);
  assert.equal(facts.names.Jeju, 'Data!#REF!');
  assert.equal(facts.names['_xlnm.Print_Area'], 'Data!$A$1:$G$6');
  assert.deepEqual(facts.conditionalFormats, [['D2:D5', '$D2>AVERAGE($D$2:$D$5)']]);
  assert.deepEqual(facts.validations, ['E2:E5']);
  // A reference the edit leaves as #REF! is read again by the next edit rather than refusing it.
  await applyXlsx(zip, [{ op: 'insert_rows', sheet: 'Data', row: 2, count: 1 }]);
  assert.equal((await workbookFacts(zip)).report[1], 'A2=Data!#REF!');
});

test('inserted and deleted columns move references, rules, names and the chart as Excel does', async () => {
  const inserted = await operationsWorkbook();
  await applyXlsx(inserted, [{ op: 'insert_columns', sheet: 'Data', column: 3, count: 1 }]);
  let facts = await workbookFacts(inserted);
  assert.deepEqual(
    facts.report,
    reportAfter([
      'SUM(Data!E2:E6)',
      'Data!A6',
      'Data!$B$6+Data!B5',
      'SUM(Data!6:6)',
      'SUM(Data!D:D)',
      'IF(Data!A6="Data!A6","same",Data!A6)',
      'SUM(Sept)',
      'SUM(Data!E6:E7)',
      'COUNTA(Data!A1:G1)',
      'SUM(Data!B2:E3)',
    ])
  );
  assert.deepEqual(facts.data, ['H2=E2/B2-1', 'H3=E3/B3-1', 'H4=E4/B4-1', 'H5=E5/B5-1', 'H6=E6/B6-1', 'E7=SUM(E2:E6)']);
  assert.equal(facts.names['_xlnm.Print_Area'], 'Data!$A$1:$H$7');
  assert.equal(facts.names.Sept, 'Data!$E$2:$E$6');
  assert.deepEqual(facts.conditionalFormats, [['E2:E6', '$E2>AVERAGE($E$2:$E$6)']]);
  assert.deepEqual(facts.validations, ['F2:F6']);
  assert.deepEqual(facts.series.slice(-2), ['Data!$A$2:$A$6', 'Data!$E$2:$E$6']);
  // The chart hangs off I2 and moves right with it.
  assert.match(await zipText(inserted, 'xl/drawings/drawing1.xml'), /<xdr:from><xdr:col>9<\/xdr:col>/);

  const deleted = await operationsWorkbook();
  await applyXlsx(deleted, [{ op: 'delete_columns', sheet: 'Data', column: 4, count: 1 }]);
  facts = await workbookFacts(deleted);
  assert.deepEqual(
    facts.report,
    reportAfter([
      'SUM(Data!#REF!)',
      'Data!A6',
      'Data!$B$6+Data!B5',
      'SUM(Data!6:6)',
      'SUM(Data!C:C)',
      'IF(Data!A6="Data!A6","same",Data!A6)',
      'SUM(Sept)',
      'SUM(Data!#REF!)',
      'COUNTA(Data!A1:E1)',
      'SUM(Data!B2:C3)',
    ])
  );
  assert.deepEqual(facts.data, ['F2=#REF!/B2-1', 'F3=#REF!/B3-1', 'F4=#REF!/B4-1', 'F5=#REF!/B5-1', 'F6=#REF!/B6-1']);
  assert.equal(facts.names.Sept, 'Data!#REF!');
  assert.equal(facts.names['_xlnm.Print_Area'], 'Data!$A$1:$F$7');
  assert.deepEqual(facts.conditionalFormats, [], 'a rule whose cells are all deleted goes');
  assert.deepEqual(facts.validations, ['D2:D6']);
  assert.match(await zipText(deleted, 'xl/drawings/drawing1.xml'), /<xdr:from><xdr:col>7<\/xdr:col>/);
});

test('an inserted row or column takes the formatting of the one above or on its left, height and width included', async () => {
  const zip = await JSZip.loadAsync(await createPortableChartWorkbook(DATA, { sheetName: 'Data' }));
  await applyXlsx(zip, [
    { op: 'set_style', sheet: 'Data', range: 'B2:D6', properties: { numberFormat: '#,##0' } },
    { op: 'set_row_height', sheet: 'Data', row: 5, height: 30 },
    { op: 'set_column_width', sheet: 'Data', column: 'B', width: 22, count: 3 },
    { op: 'insert_rows', sheet: 'Data', row: 6, count: 1 },
    { op: 'insert_columns', sheet: 'Data', column: 3, count: 1 },
  ]);
  const xml = await sheetXml(zip, 'Data');
  const style = (ref) => new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(xml)?.[1];
  assert.ok(style('B5'));
  assert.equal(style('B6'), style('B5'), 'the inserted row takes the number format of the row above');
  assert.equal(style('E6'), style('D5'));
  assert.match(xml, /<row r="6"[^>]*\bht="30"/, 'and its height');
  assert.equal(style('C3'), style('B3'), 'the inserted column takes the format of the column on its left');
  const widths = new Map();
  for (const match of xml.matchAll(/<col\b[^>]*?\bmin="(\d+)"[^>]*?\bmax="(\d+)"[^>]*?\bwidth="([\d.]+)"/g)) {
    for (let column = Number(match[1]); column <= Number(match[2]); column += 1) widths.set(column, match[3]);
  }
  assert.deepEqual(
    [2, 3, 4, 5].map((column) => widths.get(column)),
    Array(4).fill(widths.get(2))
  );
});

// append_row wrote its values into bare cells: under a table of #,##0 figures and 0.0% rates the new row read 1200 and
// 0.006. It takes the last row's formatting, as Excel's inserted row takes the one above's.
test('an appended row is formatted as the last row is', async () => {
  const zip = await JSZip.loadAsync(await createPortableChartWorkbook(DATA, { sheetName: 'Data' }));
  await applyXlsx(zip, [
    { op: 'set_style', sheet: 'Data', range: 'B2:D6', properties: { numberFormat: '#,##0' } },
    { op: 'set_style', sheet: 'Data', range: 'E2:F6', properties: { numberFormat: '0.0%' } },
    { op: 'set_row_height', sheet: 'Data', row: 6, height: 20 },
    { op: 'append_row', sheet: 'Data', values: ['세종', 1200, 1350, 1500, 0.006] },
  ]);
  const xml = await sheetXml(zip, 'Data');
  const style = (ref) => new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(xml)?.[1];
  for (const column of ['B', 'C', 'D', 'E', 'F']) assert.equal(style(`${column}7`), style(`${column}6`), column);
  assert.match(xml, /<row r="7"[^>]*\bht="20"/);
  assert.match(xml, /<c r="B7"[^>]*><v>1200<\/v>/);
  // An empty sheet's first appended row is row 1, with nothing to take from.
  await applyXlsx(zip, [
    { op: 'add_sheet', name: 'Log' },
    { op: 'append_row', sheet: 'Log', values: ['시작'] },
  ]);
  assert.match(await sheetXml(zip, 'Log'), /<row r="1"[^>]*>[\s\S]*시작/);
});

test('a shared formula whose cells would read differently is written out cell by cell; one that keeps its meaning stays shared', async () => {
  const zip = await operationsWorkbook();
  const sheet = (await workbookSheets(zip)).find((entry) => entry.name === 'Report');
  const shared = (column, text) => {
    const id = column === 'B' ? 0 : 1;
    return [9, 10, 11, 12, 13].map((row) => {
      if (row === 9) {
        return `<c r="${column}9"><f t="shared" ref="${column}9:${column}13" si="${id}">${text}</f><v>0</v></c>`;
      }
      return `<c r="${column}${row}"><f t="shared" si="${id}"/><v>0</v></c>`;
    });
  };
  const b = shared('B', 'Data!B2');
  const e = shared('E', 'B9*2');
  const rows = [9, 10, 11, 12, 13].map((row, index) => `<row r="${row}">${b[index]}${e[index]}</row>`).join('');
  zip.file(sheet.path, (await zipText(zip, sheet.path)).replace('</sheetData>', `${rows}</sheetData>`));
  await applyXlsx(zip, [{ op: 'insert_rows', sheet: 'Data', row: 4, count: 1 }]);
  const report = (await formulas(zip, 'Report')).filter((entry) => /^B(9|1[0-3])=/.test(entry));
  assert.deepEqual(report, ['B9=Data!B2', 'B10=Data!B3', 'B11=Data!B5', 'B12=Data!B6', 'B13=Data!B7']);
  const xml = await zipText(zip, sheet.path);
  assert.doesNotMatch(xml, /<c r="B\d+"><f t="shared"/);
  assert.match(xml, /<c r="E9"><f t="shared" ref="E9:E13" si="1">B9\*2<\/f>/);
});

test('a sheet named in Korean or in quotes is found in the formulas that name it', async () => {
  const zip = await JSZip.loadAsync(await createPortableChartWorkbook(DATA, { sheetName: '월별 자료' }));
  await applyXlsx(zip, [
    { op: 'add_sheet', name: '데이터' },
    { op: 'set_range', sheet: '데이터', range: 'A1:A3', values: [[1], [2], [3]] },
    { op: 'add_sheet', name: '보고서' },
    { op: 'set_formula', sheet: '보고서', cell: 'A1', formula: "=SUM('월별 자료'!D2:D6)" },
    { op: 'set_formula', sheet: '보고서', cell: 'A2', formula: '=SUM(데이터!A1:A3)+데이터!A3' },
  ]);
  // Excel leaves a name of letters unquoted, 데이터!A3, where this writer quotes it; both are read.
  const report = (await workbookSheets(zip)).find((entry) => entry.name === '보고서');
  zip.file(report.path, (await zipText(zip, report.path)).replace(/(?:'|&apos;)데이터(?:'|&apos;)!A3/, '데이터!A3'));
  await applyXlsx(zip, [
    { op: 'insert_rows', sheet: '월별 자료', row: 3, count: 2 },
    { op: 'delete_rows', sheet: '데이터', row: 2, count: 1 },
  ]);
  assert.deepEqual(await formulas(zip, '보고서'), ["A1=SUM('월별 자료'!D2:D8)", "A2=SUM('데이터'!A1:A2)+데이터!A2"]);
});

// Renamed and deleted: Excel 16 saved SUM('자료 2026'!B2:B4) and SUM(#REF!) for the same workbook, in the formulas on
// both sheets, the name, the validation list and the rule, and left the string "Data!A2" alone. (While the workbook is
// open Excel shows SUM(#REF!B2:B4); a file holding that is one Excel will not open.)
async function namingWorkbook() {
  const zip = await JSZip.loadAsync(
    await createPortableChartWorkbook(
      [
        ['권역', '9월'],
        ['수도권', 29000],
        ['부산', 26400],
        ['호남', 10700],
      ],
      { sheetName: 'Data' }
    )
  );
  await applyXlsx(zip, [
    { op: 'add_sheet', name: 'Report' },
    { op: 'add_sheet', name: 'Other' },
    { op: 'set_formula', sheet: 'Report', cell: 'A1', formula: '=SUM(Data!B2:B4)' },
    { op: 'set_formula', sheet: 'Report', cell: 'A2', formula: `='Data'!A2&"Data!A2"` },
    { op: 'set_formula', sheet: 'Report', cell: 'A3', formula: '=Other!A1+Data!$B$2' },
    { op: 'set_formula', sheet: 'Report', cell: 'A4', formula: '=SUM(Vals)' },
    { op: 'set_formula', sheet: 'Data', cell: 'C2', formula: '=B2/Data!B3' },
    { op: 'define_name', name: 'Vals', refersTo: '=Data!$B$2:$B$4' },
    { op: 'add_validation', sheet: 'Report', range: 'B1:B3', formula1: '=Data!$A$2:$A$4' },
    { op: 'add_conditional_format', sheet: 'Report', range: 'C1:C3', formula: 'C1>Data!$B$4', fillColor: 'FFF2CC' },
    { op: 'add_chart', sheet: 'Data', range: 'A1:B4', cell: 'E2', chartType: 'bar' },
  ]);
  return zip;
}

async function namingFacts(zip) {
  const report = await sheetXml(zip, 'Report');
  const workbook = await zipText(zip, 'xl/workbook.xml');
  return {
    report: await formulas(zip, 'Report'),
    name: xmlDecode(/<definedName name="Vals"[^>]*>([^<]*)</.exec(workbook)?.[1] || ''),
    validation: xmlDecode(/<formula1>([^<]*)<\/formula1>/.exec(report)?.[1] || ''),
    rule: xmlDecode(/<formula>([^<]*)<\/formula>/.exec(report)?.[1] || ''),
  };
}

test('a renamed sheet is renamed everywhere it is named, quoted where its name needs it', async () => {
  const zip = await namingWorkbook();
  const [result] = await applyXlsx(zip, [{ op: 'rename_sheet', sheet: 'Data', name: '자료 2026' }]);
  // Three Report formulas, Data's own, the name, the validation, the rule and the chart's three series references.
  assert.equal(result.referencesRewritten, 10);
  assert.deepEqual(await namingFacts(zip), {
    report: [
      "A1=SUM('자료 2026'!B2:B4)",
      `A2='자료 2026'!A2&"Data!A2"`,
      "A3=Other!A1+'자료 2026'!$B$2",
      'A4=SUM(Vals)',
    ],
    name: "'자료 2026'!$B$2:$B$4",
    validation: "'자료 2026'!$A$2:$A$4",
    rule: "C1>'자료 2026'!$B$4",
  });
  assert.deepEqual(await formulas(zip, '자료 2026'), ["C2=B2/'자료 2026'!B3"]);
  const series = [...(await zipText(zip, 'xl/charts/chart1.xml')).matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((match) =>
    xmlDecode(match[1])
  );
  assert.ok(series.length && series.every((text) => text.startsWith("'자료 2026'!")), series.join(' '));
});

test('a deleted sheet leaves #REF! wherever it was named, as Excel saves it', async () => {
  const zip = await namingWorkbook();
  await applyXlsx(zip, [{ op: 'delete_sheet', sheet: 'Data' }]);
  assert.deepEqual(await namingFacts(zip), {
    report: ['A1=SUM(#REF!)', 'A2=#REF!&"Data!A2"', 'A3=Other!A1+#REF!', 'A4=SUM(Vals)'],
    name: '#REF!',
    validation: '#REF!',
    rule: 'C1>#REF!',
  });
  // Excel's open-workbook form, #REF!B2:B4, is read as the error it is: a later insert leaves it alone.
  const report = (await workbookSheets(zip)).find((entry) => entry.name === 'Report');
  zip.file(report.path, (await zipText(zip, report.path)).replace('<f>SUM(#REF!)</f>', '<f>SUM(#REF!B2:B4)</f>'));
  await applyXlsx(zip, [{ op: 'insert_rows', sheet: 'Report', row: 1, count: 1 }]);
  assert.deepEqual((await namingFacts(zip)).report, [
    'A2=SUM(#REF!B2:B4)',
    'A3=#REF!&"Data!A2"',
    'A4=Other!A1+#REF!',
    'A5=SUM(Vals)',
  ]);
});

// Two sheets drawing through one drawing part is a package Excel will not open, and that is what a copied sheet with a
// chart was. Excel's own copy has its own chart reading the copy, its own notes and print area, the copy's formulas
// read the copy (Report!B2 became 'Report 사본'!B2), and a workbook name reading the sheet gains a copy-level twin.
test('a copied sheet gets its own chart, notes and names, pointed at the copy, as Excel copies it', async () => {
  const zip = await JSZip.loadAsync(
    await createPortableChartWorkbook(
      DATA.map((row) => row.slice(0, 4)),
      { sheetName: 'Report' }
    )
  );
  await applyXlsx(zip, [
    { op: 'add_chart', sheet: 'Report', range: 'A1:A6,D1:D6', cell: 'F2', chartType: 'bar', title: '9월' },
    { op: 'add_note', sheet: 'Report', cell: 'A1', text: '자료: 운영관리시스템' },
    { op: 'set_page_setup', sheet: 'Report', printArea: 'A1:D6' },
    { op: 'set_formula', sheet: 'Report', cell: 'E2', formula: '=Report!D2*2+D3' },
    { op: 'define_name', name: 'Total', refersTo: '=Report!$D$2' },
    { op: 'copy_sheet', sheet: 'Report', name: 'Report 사본' },
  ]);
  const [source, copy] = await workbookSheets(zip);
  const owned = async (sheet, type) => {
    const rels = await zipText(zip, sheet.path.replace(/([^/]+)$/, '_rels/$1.rels'));
    return new RegExp(`Type="[^"]*/${type}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*/${type}"`)
      .exec(rels)
      ?.slice(1)
      .find(Boolean);
  };
  for (const type of ['drawing', 'comments', 'vmlDrawing']) {
    assert.ok(await owned(copy, type), `the copy has a ${type}`);
    assert.notEqual(await owned(copy, type), await owned(source, type), `the copy's ${type} is its own`);
  }
  const charts = Object.keys(zip.files)
    .filter((part) => /^xl\/charts\/chart\d+\.xml$/.test(part))
    .sort();
  assert.equal(charts.length, 2);
  const series = [...(await zipText(zip, charts[1])).matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((match) =>
    xmlDecode(match[1])
  );
  assert.ok(series.length && series.every((text) => text.startsWith("'Report 사본'!")), series.join(' '));
  assert.deepEqual(
    (await formulas(zip, 'Report 사본')).filter((entry) => entry.startsWith('E2')),
    ["E2='Report 사본'!D2*2+D3"]
  );
  assert.deepEqual(
    (await formulas(zip, 'Report')).filter((entry) => entry.startsWith('E2')),
    ['E2=Report!D2*2+D3']
  );
  const names = [
    ...(await zipText(zip, 'xl/workbook.xml')).matchAll(/<definedName\b([^>]*)>([^<]*)<\/definedName>/g),
  ].map(
    (match) =>
      `${/name="([^"]+)"/.exec(match[1])[1]}@${/localSheetId="(\d+)"/.exec(match[1])?.[1] ?? '-'}=${xmlDecode(match[2])}`
  );
  assert.deepEqual(names.sort(), [
    'Total@-=Report!$D$2',
    "Total@1='Report 사본'!$D$2",
    '_xlnm.Print_Area@0=Report!$A$1:$D$6',
    "_xlnm.Print_Area@1='Report 사본'!$A$1:$D$6",
  ]);
});

// Excel's calculation chain names formula cells by sheet; left naming a deleted sheet, Excel would not open the file.
test('deleting a sheet drops the calculation chain that named its cells', async () => {
  const zip = await operationsWorkbook();
  zip.file(
    'xl/calcChain.xml',
    '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A1" i="2"/></calcChain>'
  );
  const rels = await zipText(zip, 'xl/_rels/workbook.xml.rels');
  zip.file(
    'xl/_rels/workbook.xml.rels',
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'
    )
  );
  await applyXlsx(zip, [{ op: 'delete_sheet', sheet: 'Report' }]);
  assert.equal(zip.file('xl/calcChain.xml'), null);
  assert.doesNotMatch(await zipText(zip, 'xl/_rels/workbook.xml.rels'), /calcChain/);
});

// A sort moves formulas with their rows. Excel 16, sorting A2:G6 by column C ascending, wrote each moved row's formula
// with its unqualified references following the row where relative and every sheet-qualified one left as it was.
test('a sorted row takes its formulas along as Excel moves them', async () => {
  const zip = await JSZip.loadAsync(
    await createPortableChartWorkbook(
      DATA.map((row) => [row[0], row[1], row[3]]),
      { sheetName: 'Data' }
    )
  );
  await applyXlsx(zip, [
    { op: 'add_sheet', name: 'Report' },
    { op: 'set_range', sheet: 'Report', range: 'C1:C7', values: [[1], [2], [3], [4], [5], [6], [7]] },
    ...[2, 3, 4, 5, 6].flatMap((row) => [
      { op: 'set_formula', sheet: 'Data', cell: `D${row}`, formula: `=C${row}/B${row}-1` },
      { op: 'set_formula', sheet: 'Data', cell: `E${row}`, formula: `=C${row}/SUM($C$2:$C$6)` },
      { op: 'set_formula', sheet: 'Data', cell: `F${row}`, formula: `=Report!C${row}+C${row + 1}+$B${row}+B$2` },
      { op: 'set_formula', sheet: 'Data', cell: `G${row}`, formula: `=Data!C${row}*2+SUM(B${row}:C${row})` },
    ]),
    { op: 'set_formula', sheet: 'Data', cell: 'C7', formula: '=SUM(C2:C6)' },
    { op: 'set_formula', sheet: 'Report', cell: 'A1', formula: '=Data!A2' },
    { op: 'sort_range', sheet: 'Data', range: 'A2:G6', by: 'C', order: 'asc', hasHeader: false },
  ]);
  const data = await formulas(zip, 'Data');
  const at = (prefix) => data.filter((entry) => entry.startsWith(prefix));
  assert.deepEqual(at('D'), ['D2=C2/B2-1', 'D3=C3/B3-1', 'D4=C4/B4-1', 'D5=C5/B5-1', 'D6=C6/B6-1']);
  assert.deepEqual(
    at('E'),
    [2, 3, 4, 5, 6].map((row) => `E${row}=C${row}/SUM($C$2:$C$6)`)
  );
  assert.deepEqual(at('F'), [
    'F2=Report!C6+C3+$B2+B$2',
    'F3=Report!C5+C4+$B3+B$2',
    'F4=Report!C4+C5+$B4+B$2',
    'F5=Report!C3+C6+$B5+B$2',
    'F6=Report!C2+C7+$B6+B$2',
  ]);
  assert.deepEqual(at('G'), [
    'G2=Data!C6*2+SUM(B2:C2)',
    'G3=Data!C5*2+SUM(B3:C3)',
    'G4=Data!C4*2+SUM(B4:C4)',
    'G5=Data!C3*2+SUM(B5:C5)',
    'G6=Data!C2*2+SUM(B6:C6)',
  ]);
  assert.deepEqual(at('C7'), ['C7=SUM(C2:C6)']);
  assert.deepEqual(await formulas(zip, 'Report'), ['A1=Data!A2']);
  const values = (await sheetXml(zip, 'Data'))
    .match(/<c r="A[2-6]"[^>]*>[\s\S]*?<\/c>/g)
    .map((cell) => /<t[^>]*>([^<]*)</.exec(cell)?.[1]);
  assert.deepEqual(values, ['제주', '강원', '호남', '부산', '수도권']);
});

// Excel stores a filled-down column once. Sorted whole, each cell takes its own formula; cut by the sort, the run
// would be rewritten under rows it no longer matches, so the sort is refused.
test('a formula filled down as one moves cell by cell when sorted whole, and refuses a sort that cuts it', async () => {
  const filled = (last) =>
    [2, 3, 4, 5, 6, 7]
      .filter((row) => row <= last)
      .map((row) =>
        row === 2
          ? `<c r="D2"><f t="shared" ref="D2:D${last}" si="0">C2/B2-1</f><v>0</v></c>`
          : `<c r="D${row}"><f t="shared" si="0"/><v>0</v></c>`
      );
  const workbookWith = async (last) => {
    const zip = await JSZip.loadAsync(
      await createPortableChartWorkbook(
        DATA.map((row) => [row[0], row[1], row[3]]),
        { sheetName: 'Data' }
      )
    );
    const [sheet] = await workbookSheets(zip);
    let xml = await zipText(zip, sheet.path);
    for (const [index, cell] of filled(last).entries()) {
      const row = index + 2;
      xml = new RegExp(`<row r="${row}"[^>]*>`).test(xml)
        ? xml.replace(new RegExp(`(<row r="${row}"[^>]*>[\\s\\S]*?)(</row>)`), `$1${cell}$2`)
        : xml.replace('</sheetData>', `<row r="${row}">${cell}</row></sheetData>`);
    }
    zip.file(sheet.path, xml);
    return zip;
  };
  const whole = await workbookWith(6);
  await applyXlsx(whole, [
    { op: 'sort_range', sheet: 'Data', range: 'A2:D6', by: 'C', order: 'asc', hasHeader: false },
  ]);
  assert.deepEqual(
    (await formulas(whole, 'Data')).filter((entry) => entry.startsWith('D')),
    [2, 3, 4, 5, 6].map((row) => `D${row}=C${row}/B${row}-1`)
  );
  assert.doesNotMatch(await sheetXml(whole, 'Data'), /t="shared"/);
  const cut = await workbookWith(7);
  await assert.rejects(
    applyXlsx(cut, [{ op: 'sort_range', sheet: 'Data', range: 'A2:D6', by: 'C', order: 'asc', hasHeader: false }]),
    /would move part of a formula filled down as one, D2 through D7/
  );
});

// Excel's own drawing part declares only xdr and a at its root, each chart frame naming r where it uses it. A picture
// added to it with an undeclared r:embed was a package Excel refused to open.
test('a picture added to a drawing Excel wrote declares the relationship prefix it uses', async (t) => {
  const zip = await operationsWorkbook();
  const drawingPart = 'xl/drawings/drawing1.xml';
  const excelRoot = (await zipText(zip, drawingPart)).replace(/<xdr:wsDr\b[^>]*>/, (root) =>
    root.replace(/\s+xmlns:r="[^"]*"/, '')
  );
  zip.file(drawingPart, excelRoot);
  assert.doesNotMatch(excelRoot, /<xdr:wsDr\b[^>]*xmlns:r=/);
  const folder = await mkdtemp(join(tmpdir(), 'mixdog-drawing-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const picture = join(folder, 'dot.png');
  await writeFile(picture, PNG_PIXEL);
  await applyXlsx(zip, [{ op: 'add_image', sheet: 'Data', path: picture, cell: 'I20', width: 40, height: 40 }]);
  const drawing = await zipText(zip, drawingPart);
  const users = [...drawing.matchAll(/<[\w:]+\b[^>]*\br:(?:embed|id|link)="[^"]*"[^>]*>/g)].map((match) => match[0]);
  assert.equal(users.length, 2, 'the chart frame and the picture');
  for (const element of users)
    assert.match(
      element,
      /xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/,
      element
    );
});

// Excel moves a note with its cell, box and all, and deletes it with its cell.
test('a note moves with its cell and goes with it', async () => {
  const zip = await operationsWorkbook();
  await applyXlsx(zip, [
    { op: 'add_note', sheet: 'Data', cell: 'A6', text: '신규 권역 검토 중' },
    { op: 'add_note', sheet: 'Data', cell: 'B3', text: '7월 잠정치' },
  ]);
  const notes = async () => {
    const comments = Object.keys(zip.files).find((part) => /^xl\/comments\d*\.xml$/.test(part));
    const vml = Object.keys(zip.files).find((part) => /^xl\/drawings\/vmlDrawing\d*\.vml$/.test(part));
    const shapes = [...(await zipText(zip, vml)).matchAll(/<x:Row>(\d+)<\/x:Row>\s*<x:Column>(\d+)<\/x:Column>/g)];
    return {
      refs: [...(await zipText(zip, comments)).matchAll(/<comment\b[^>]*\bref="([^"]+)"/g)].map((match) => match[1]),
      cells: shapes.map((match) => `${String.fromCharCode(65 + Number(match[2]))}${Number(match[1]) + 1}`),
    };
  };
  const before = await notes();
  await applyXlsx(zip, [{ op: 'insert_rows', sheet: 'Data', row: 4, count: 2 }]);
  const inserted = await notes();
  assert.deepEqual(
    inserted.refs,
    before.refs.map((ref) => (ref === 'A6' ? 'A8' : ref))
  );
  assert.deepEqual(inserted.cells.sort(), ['A8', 'B3']);
  await applyXlsx(zip, [{ op: 'delete_rows', sheet: 'Data', row: 8, count: 1 }]);
  assert.deepEqual((await notes()).refs, ['B3']);
  assert.deepEqual((await notes()).cells, ['B3']);
  await applyXlsx(zip, [{ op: 'insert_columns', sheet: 'Data', column: 1, count: 1 }]);
  assert.deepEqual(await notes(), { refs: ['C3'], cells: ['C3'] });
});

test('what cannot be rewritten refuses the edit, listed, and leaves the workbook as it was', async () => {
  const zip = await operationsWorkbook();
  await applyXlsx(zip, [{ op: 'add_table', sheet: 'Data', range: 'A1:F6', name: 'Hubs' }]);
  const before = await sheetXml(zip, 'Report');
  const dataBefore = await sheetXml(zip, 'Data');
  await assert.rejects(
    applyXlsx(zip, [{ op: 'insert_columns', sheet: 'Data', column: 3, count: 1 }]),
    /Portable insert_columns at Data column C cannot rewrite 1 thing\(s\) that name the cells it moves: table Hubs A1:F6[\s\S]*Office backend/
  );
  assert.equal(await sheetXml(zip, 'Report'), before);
  assert.equal(await sheetXml(zip, 'Data'), dataBefore);
  // A row inside the table widens it, as Excel's does.
  await applyXlsx(zip, [{ op: 'insert_rows', sheet: 'Data', row: 4, count: 1 }]);
  const table = Object.keys(zip.files).find((part) => /^xl\/tables\/table\d+\.xml$/.test(part));
  assert.match(await zipText(zip, table), /<table\b[^>]*\bref="A1:F7"/);
});
