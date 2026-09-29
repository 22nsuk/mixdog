import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool } from './index.mjs';
import { chartXml } from './portable/portable-chart.mjs';
import { parts, value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// pptxgenjs writes the chart relationship as an absolute part name
// ("/ppt/charts/chart1.xml"), where a hand-built deck writes "../charts/chart1.xml".
const DECK = `
// BRIEF
// facts: sample — test fixture, illustrative figures
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addChart(pres.ChartType.bar, [{ name: 'Retention', labels: ['Self-serve', 'Guided'], values: [38, 52] }], { x: 1, y: 1, w: 11, h: 5 });
await pres.writeFile({ fileName: OUTPUT });
`;

test('set_chart_data edits a pptxgenjs chart through its absolute relationship target, and a duplicated slide owns its copy', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'chart.pptx');
  const authored = value(
    await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const source = await parts(deck);
  assert.match(await source.text('ppt/slides/_rels/slide1.xml.rels'), /Target="\/ppt\/charts\/chart1\.xml"/);

  const output = join(cwd, 'chart-edited.pptx');
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: deck,
        mode: 'portable',
        output,
        snapshotAfter: false,
        operations: [{ op: 'duplicate_slide', slide: 1 }],
      },
      { cwd }
    )
  );
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 2,
            shape: 1,
            categories: ['Self-serve', 'Guided'],
            series: [{ name: 'Retention', values: [7, 9] }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(edited.results[0].chart, 'ppt/charts/chart2.xml');
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));

  const result = await parts(output);
  assert.equal(
    result.has('ppt/charts/chart2.xml'),
    true,
    'the copy owns its chart part instead of editing the source page'
  );
  assert.match(await result.text('ppt/slides/_rels/slide1.xml.rels'), /Target="\/ppt\/charts\/chart1\.xml"/);
  assert.match(await result.text('ppt/slides/_rels/slide2.xml.rels'), /Target="\/ppt\/charts\/chart2\.xml"/);
  const source1 = await result.text('ppt/charts/chart1.xml');
  assert.match(source1, /<c:v>38<\/c:v>/, 'the page that was not edited keeps the numbers it was approved with');
  const copy = await result.text('ppt/charts/chart2.xml');
  assert.match(copy, /<c:v>7<\/c:v>/);
  assert.match(copy, /<c:v>9<\/c:v>/);
  assert.doesNotMatch(copy, /<c:v>38<\/c:v>/);
});

// A chart PowerPoint saved cites its workbook as rId3 beside its style and colour parts, and may name its series in
// plain text. The refresh rewrote the chart's relationships as a lone rId1: the chart still cited rId3, so Edit Data
// opened nothing (chart_data_unlinked), the style parts were orphaned, and the text name kept the old series name.
test('a data refresh keeps the chart’s own relationships and renames a series written as text', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'saved.pptx');
  const authored = value(
    await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(deck));
  // pptxgenjs numbers charts across the process, so the part is found rather than assumed.
  const chartPart = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const relsPath = chartPart.replace('ppt/charts/', 'ppt/charts/_rels/') + '.rels';
  const rels = await zip.file(relsPath).async('string');
  const packageId = /Id="([^"]+)"[^>]*\/package"|\/package"[^>]*Id="([^"]+)"/.exec(rels);
  const id = packageId[1] || packageId[2];
  zip.file(
    relsPath,
    rels
      .replaceAll(`Id="${id}"`, 'Id="rId3"')
      .replace(
        '</Relationships>',
        '<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/chartStyle" Target="style1.xml"/></Relationships>'
      )
  );
  zip.file(
    'ppt/charts/style1.xml',
    '<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="201"/>'
  );
  const chart = (await zip.file(chartPart).async('string'))
    .replace(/(<c:externalData\b[^>]*\br:id=")[^"]*(")/, '$1rId3$2')
    .replace(/<c:tx>\s*<c:strRef>[\s\S]*?<\/c:strRef>\s*<\/c:tx>/, '<c:tx><c:v>Value</c:v></c:tx>');
  assert.match(chart, /<c:tx><c:v>Value<\/c:v><\/c:tx>/);
  zip.file(chartPart, chart);
  await writeFile(deck, await zip.generateAsync({ type: 'nodebuffer' }));

  const opened = value(await executeOfficeTool({ action: 'open', path: deck, mode: 'portable' }, { cwd }));
  const refreshed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            categories: ['Self-serve', 'Guided'],
            series: [{ name: '유지율', values: [41, 55] }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(
    refreshed.audit.top.some((issue) => issue.code === 'chart_data_unlinked'),
    false,
    JSON.stringify(refreshed.audit)
  );
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
  const saved = await parts(opened.output || deck);
  const savedRels = await saved.text(relsPath);
  assert.match(savedRels, /Id="rId3"[^>]*\/package"/);
  assert.match(savedRels, /Id="rId1"[^>]*chartStyle"[^>]*Target="style1\.xml"/, 'the style part stays related');
  const savedChart = await saved.text(chartPart);
  assert.match(savedChart, /<c:externalData r:id="rId3">/);
  assert.match(savedChart, /<c:tx><c:v>유지율<\/c:v><\/c:tx>/);
  assert.match(savedChart, /<c:v>55<\/c:v>/);
});

test('a column starts its axis at zero unless the caller zooms in, a line keeps its range', () => {
  const bars = { chartType: 'column', categories: ['1월', '2월'], series: [{ name: '처리량', values: [4610, 4720] }] };
  assert.match(chartXml(bars), /<c:min val="0"\/>/);
  assert.doesNotMatch(chartXml({ ...bars, zeroBaseline: false }), /<c:min val="0"\/>/);
  assert.doesNotMatch(chartXml({ ...bars, chartType: 'line' }), /<c:min val="0"\/>/);
  assert.match(chartXml({ ...bars, chartType: 'line', zeroBaseline: true }), /<c:min val="0"\/>/);
});

test('new numbers keep the chart the deck was approved with', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'monthly.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: deck,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_chart',
            slide: 1,
            chartType: 'column',
            title: '분기 처리량',
            categories: ['10월', '11월', '12월'],
            series: [{ name: '처리량', values: [4120, 4480, 4390], color: 'B04A2F' }],
            showValues: true,
            dataLabelPosition: 'outside_end',
            valueNumberFormat: '#,##0',
            zeroBaseline: true,
            left: 60,
            top: 110,
            width: 700,
            height: 330,
          },
        ],
      },
      { cwd }
    )
  );
  const refreshed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            categories: ['1월', '2월', '3월'],
            series: [{ name: '처리량', values: [4610, 4720, 5010] }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(refreshed.results[0].preserved, ['dataLabels', 'numberFormat', 'zeroBaseline', 'seriesColors']);
  const packaged = await parts(deck);
  const chart = await packaged.text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:v>5010<\/c:v>/);
  assert.match(chart, /<c:showVal val="1"\/>/);
  assert.match(chart, /<c:dLblPos val="outEnd"\/>/);
  assert.match(chart, /<c:min val="0"\/>/);
  assert.match(chart, /formatCode="#,##0"/);
  assert.match(chart, /<a:srgbClr val="B04A2F"\/>/);
  assert.match(chart, /<a:t>분기 처리량<\/a:t>/);

  // An explicit field still overrides what the chart carried.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            series: [{ name: '처리량', values: [4610, 4720, 5010] }],
            showValues: false,
          },
        ],
      },
      { cwd }
    )
  );
  const plain = await (await parts(deck)).text('ppt/charts/chart1.xml');
  assert.doesNotMatch(plain, /<c:dLbls>/);
  assert.match(plain, /<a:srgbClr val="B04A2F"\/>/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A bar chart authored bottom-up (PowerPoint's and pptxgenjs's default, and what a template usually carries) keeps its
// order on a refresh and says so; categoryOrder turns the bars to read from the top in the order given, or back.
test('a bar chart authored bottom-up keeps its order, says so, and turns over on categoryOrder', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'bars.pptx');
  // pptxgenjs draws columns unless barDir says bars; its category axis runs bottom-up, PowerPoint's default.
  const bars = DECK.replace('{ x: 1, y: 1, w: 11, h: 5 }', "{ x: 1, y: 1, w: 11, h: 5, barDir: 'bar' }");
  const authored = value(
    await executeOfficeTool({ action: 'author', path: deck, script: bars, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const opened = value(await executeOfficeTool({ action: 'open', path: deck, mode: 'portable' }, { cwd }));
  // pptxgenjs numbers its chart parts across the process, so the part is the one the refresh names.
  let chartPart = '';
  const refresh = async (extra = {}) => {
    const result = value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: opened.session,
          operations: [
            {
              op: 'set_chart_data',
              slide: 1,
              shape: 1,
              categories: ['6월', '7월', '8월', '9월'],
              series: [{ name: '오류 (건)', values: [8200, 5900, 3100, 2700] }],
              ...extra,
            },
          ],
        },
        { cwd }
      )
    ).results[0];
    chartPart = result.chart;
    return result;
  };
  // An opened deck is edited in its working copy, which the open names as its output.
  assert.match(opened.output, /bars\.mixdog-edit\.pptx$/);
  const axes = async () => {
    const chart = await (await parts(opened.output)).text(chartPart);
    return [
      /<c:catAx>[\s\S]*?<c:orientation val="([^"]+)"\/>/.exec(chart)?.[1],
      /<c:valAx>[\s\S]*?<c:crosses val="([^"]+)"\/>/.exec(chart)?.[1],
    ];
  };
  const kept = await refresh();
  assert.equal(kept.readingOrder, 'bottomUp', JSON.stringify(kept));
  assert.match(kept.note, /categoryOrder:'topDown'/);
  assert.deepEqual(await axes(), ['minMax', 'autoZero'], 'the authored order stays');
  const turned = await refresh({ categoryOrder: 'topDown' });
  assert.equal(turned.readingOrder, undefined);
  assert.deepEqual(await axes(), ['maxMin', 'max'], 'the first category on top, the value axis under the bars');
  assert.equal((await refresh()).readingOrder, undefined, 'a later refresh keeps the order it was given');
  await refresh({ categoryOrder: 'bottomUp' });
  assert.deepEqual(await axes(), ['minMax', 'autoZero']);
  await assert.rejects(
    executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            series: [{ name: '오류 (건)', values: [1, 2, 3, 4] }],
            categoryOrder: 'sideways',
          },
        ],
      },
      { cwd }
    ).then(value),
    /categoryOrder must be 'topDown' or 'bottomUp'/
  );
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));

  // A column chart has no top or bottom to its categories: the field is refused rather than ignored.
  const columns = join(cwd, 'columns.pptx');
  const columnDeck = value(
    await executeOfficeTool({ action: 'author', path: columns, script: DECK, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: columnDeck.session }, { cwd }));
  const reopened = value(await executeOfficeTool({ action: 'open', path: columns, mode: 'portable' }, { cwd }));
  await assert.rejects(
    executeOfficeTool(
      {
        action: 'batch',
        session: reopened.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            series: [{ name: 'Retention', values: [1, 2] }],
            categoryOrder: 'topDown',
          },
        ],
      },
      { cwd }
    ).then(value),
    /orders a horizontal bar chart's categories/
  );
  value(await executeOfficeTool({ action: 'close', session: reopened.session }, { cwd }));
});
