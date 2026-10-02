import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { parts, value, workspace } from './office-test-support.mjs';
import { localBrowserAvailable } from '../shared/browser-launch.mjs';

const skip = !localBrowserAvailable() && 'no local Chrome or Edge';

const WORKBOOK = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>운영 보고</title>
<style>
body { margin: 0; font-family: 'Malgun Gothic', sans-serif; color: #374151; }
.report { width: 900px; padding: 24px; box-sizing: border-box; font-size: 13px; }
.title { font-size: 22px; font-weight: 700; color: #111827; line-height: 30px; margin: 0 0 16px; }
.kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 0 0 20px; }
.kpi { background: #EEF4F1; padding: 12px 14px; }
.kpi .v { font-size: 26px; font-weight: 700; color: #1F5E4B; line-height: 34px; margin: 0; }
.kpi .l { font-size: 12px; line-height: 18px; margin: 0; }
.body { display: grid; grid-template-columns: 360px 1fr; gap: 24px; }
table { border-collapse: collapse; font-size: 12px; }
.report table { width: 100%; }
th { text-align: right; background: #EEF4F1; padding: 6px 10px; line-height: 18px; }
td { text-align: right; padding: 6px 10px; line-height: 18px; }
.t { text-align: left; }
</style></head><body>
<section data-sheet="보고" class="report">
  <p class="title">대기 시간이 37분 줄었다</p>
  <div class="kpis">
    <div class="kpi"><p class="v" data-formula="={w6}-{w9}" data-format='0"분"'>37분</p><p class="l">평균 대기 시간 단축</p></div>
    <div class="kpi"><p class="v" data-formula="={v9}" data-format='#,##0"건"'>63,000건</p><p class="l">9월 처리량</p></div>
  </div>
  <div class="body">
    <table>
      <thead><tr><th class="t" id="mh">월</th><th id="vh">처리량 (건)</th><th id="wh">평균 대기 (분)</th></tr></thead>
      <tbody>
        <tr><td class="t" id="m6" data-value="2026-06-01" data-format='m"월"'>6월</td><td id="v6" data-formula="=SUMIFS(Ops[처리량],Ops[월],{m6})" data-format="#,##0">55,100</td><td id="w6" data-formula="=SUMIFS(Ops[대기],Ops[월],{m6})" data-format="0">52</td></tr>
        <tr><td class="t" id="m9" data-value="2026-09-01" data-format='m"월"'>9월</td><td id="v9" data-note="자료: 표본 데이터" data-formula="=SUMIFS(Ops[처리량],Ops[월],{m9})" data-format="#,##0">63,000</td><td id="w9" data-formula="=SUMIFS(Ops[대기],Ops[월],{m9})" data-format="0">15</td></tr>
      </tbody>
    </table>
    <div data-chart='{"type":"col","colors":["C9CED6","1F5E4B"],"format":"0\\"분\\""}' data-range="{mh}:{m9},{wh}:{w9}" style="height:200px"></div>
  </div>
</section>
<section data-sheet="데이터">
  <table data-table="Ops" data-freeze="header">
    <thead><tr><th class="t">월</th><th>처리량</th><th>대기</th></tr></thead>
    <tbody>
      <tr><td class="t" data-value="2026-06-01" data-format="yyyy-mm">2026-06</td><td>55,100</td><td>52</td></tr>
      <tr><td class="t" data-value="2026-09-01" data-format="yyyy-mm">2026-09</td><td>63,000</td><td>15</td></tr>
    </tbody>
  </table>
</section>
</body></html>`;

test('author writes an HTML report sheet as a native, live workbook', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'report.xlsx');
  const authored = value(
    await executeOfficeTool({ action: 'author', path, script: WORKBOOK, mode: 'portable' }, { cwd })
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  assert.ok(authored.render?.compare?.length >= 1, 'the HTML sheet and the Excel render come back as pairs');
  const snapshot = value(
    await executeOfficeTool({ action: 'snapshot', session: authored.session, sheet: '보고' }, { cwd })
  );
  const cells = snapshot.document.sheets[0].cells;
  const formulas = cells.filter((cell) => cell.formula);
  // {id} placeholders land on the cells those elements became; the KPI reads the table, the table reads the data sheet.
  assert.ok(
    formulas.some((cell) => /^[A-Z]+\d+-[A-Z]+\d+$/.test(cell.formula) && cell.value === 37),
    JSON.stringify(formulas)
  );
  assert.ok(
    formulas.some((cell) => /SUMIFS\(Ops\[처리량\],Ops\[월\],[A-Z]+\d+\)/.test(cell.formula) && cell.value === 63000)
  );
  // A table stretched by the grid row beside it still holds one line a cell: no wrap, set in the middle.
  const figure = formulas.find((cell) => cell.value === 55100);
  assert.notEqual(figure.style.wrapText, true, JSON.stringify(figure));
  assert.ok(snapshot.document.sheets[0].mergedRanges?.length >= 2, 'each card text spans its card');
  await executeOfficeTool({ action: 'close', session: authored.session }, { cwd });
  const xlsx = await parts(path);
  const chart = await xlsx.text('xl/charts/chart1.xml');
  // Dated categories stay dates read in their cells' format: the axis shows 6월, never the serial 46174.
  assert.match(
    chart,
    /<c:cat><c:numRef><c:f>&apos;보고&apos;!\$[A-Z]+\$\d+:\$[A-Z]+\$\d+<\/c:f><c:numCache><c:formatCode>m&quot;월&quot;<\/c:formatCode>/
  );
  assert.match(
    chart,
    /<c:catAx>[\s\S]*?<c:numFmt formatCode="m&quot;월&quot;" sourceLinked="1"\/>[\s\S]*?<c:auto val="0"\/>/
  );
  assert.match(
    chart,
    /<c:val><c:numRef>[\s\S]*?<c:v>52<\/c:v>[\s\S]*?<c:v>15<\/c:v>/,
    'the value cache holds the computed figures'
  );
  assert.match(await xlsx.text('xl/comments1.xml'), /자료: 표본 데이터/, 'data-note is the cell note');
  assert.match(await xlsx.text('xl/tables/table1.xml'), /name="Ops"/, 'data-table is an Excel table');
});

test('HTML table values preserve identifiers and text while typing valid figures', { skip }, async (t) => {
  const cwd = await workspace(t);
  const cases = [
    ['007', '007'],
    ['1,2', '1,2'],
    ['1 2', '1 2'],
    ['1e3', '1e3'],
    ['184,200', 184200],
    ['+12.0%', 0.12],
    ['2026-09-30', 46295],
  ];
  const authored = value(
    await executeOfficeTool(
      {
        action: 'author',
        path: join(cwd, 'values.xlsx'),
        mode: 'portable',
        render: false,
        script: `<!doctype html><style>
      body { margin: 0; }
      section { width: 400px; }
      table { border-collapse: collapse; table-layout: fixed; width: 100%; }
      th, td { padding: 0; height: 24px; }
    </style><section data-sheet="Data"><table>
      <thead><tr><th>Text</th><th>Explicit value</th></tr></thead><tbody>
      ${cases.map(([text]) => `<tr><td>${text}</td><td data-value="${text}">shown</td></tr>`).join('')}
      </tbody></table></section>`,
      },
      { cwd }
    )
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: authored.session }, { cwd }));
  const cells = new Map(snapshot.document.sheets[0].cells.map((cell) => [cell.ref, cell]));
  cases.forEach(([text, expected], index) => {
    for (const column of ['A', 'B']) {
      assert.equal(cells.get(`${column}${index + 2}`)?.value, expected, `${column}: ${text}`);
    }
  });
  assert.equal(cells.get('A7').style.numberFormat, '+0.0%;-0.0%;0.0%');
});

test('a workbook without a data-sheet section is refused', { skip }, async (t) => {
  const cwd = await workspace(t);
  const refused = value(
    await executeOfficeTool(
      {
        action: 'author',
        path: join(cwd, 'bare.xlsx'),
        script: '<!doctype html><html><body><p>본문</p></body></html>',
        mode: 'portable',
      },
      { cwd }
    )
  );
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /data-sheet/);
});
