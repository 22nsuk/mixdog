import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradientFillXml,
  mergeAccentSeries,
  nativeGradients,
  orderChartChildren,
  normalizeChartFonts,
  orderPresentationLists,
  pruneUndeclaredAxisIds,
  uniqueShapeIds,
} from './pptx-script-normalize.mjs';

// pptxgenjs numbers a table frame as its ordinal times the slide number plus one: the first table on slide 5 took
// id 6 beside a text box that was id 6 too, and a batch naming shape 6 could not tell the two apart.
test('an authored slide gives every drawing object an id of its own', () => {
  const object = (tag, id) => `<p:${tag}><p:nv><p:cNvPr id="${id}" name="${tag}${id}"/></p:nv></p:${tag}>`;
  const xml = `<p:spTree>${object('sp', 1)}${object('sp', 2)}${object('graphicFrame', 6)}${object('sp', 5)}${object('sp', 6)}${object('sp', 25)}</p:spTree>`;
  const { xml: out, changed } = uniqueShapeIds(xml);
  assert.equal(changed, 1);
  assert.deepEqual(
    [...out.matchAll(/id="(\d+)"/g)].map((match) => Number(match[1])),
    [1, 2, 6, 5, 26, 25],
    'the table keeps its id; the later text box takes the next free one'
  );
  assert.equal(uniqueShapeIds(out).changed, 0, 'idempotent');
});

test('a 2D chart group keeps only the axis ids its plot area declares', () => {
  const xml =
    '<c:plotArea><c:barChart><c:barDir val="col"/><c:gapWidth val="80"/>' +
    '<c:axId val="11"/><c:axId val="22"/><c:axId val="33"/></c:barChart>' +
    '<c:catAx><c:axId val="11"/><c:crossAx val="22"/></c:catAx><c:valAx><c:axId val="22"/><c:crossAx val="11"/></c:valAx></c:plotArea>';
  const pruned = pruneUndeclaredAxisIds(xml);
  assert.equal(pruned.changed, true);
  assert.equal((pruned.xml.match(/<c:axId val="33"\/>/g) || []).length, 0);
  assert.equal((pruned.xml.match(/<c:axId val="\d+"\/>/g) || []).length, 4, 'two in the group, one per axis');
  assert.equal(pruneUndeclaredAxisIds(pruned.xml).changed, false);
  // A pie has no axes at all and is left as written.
  assert.equal(pruneUndeclaredAxisIds('<c:plotArea><c:pieChart/></c:plotArea>').changed, false);
});

test('the notes master list moves ahead of the slide list, and only when it follows it', () => {
  const written =
    '<p:presentation><p:sldMasterIdLst><p:sldMasterId id="1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256"/></p:sldIdLst>' +
    '<p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst><p:sldSz cx="1" cy="1"/></p:presentation>';
  const ordered = orderPresentationLists(written);
  assert.equal(ordered.changed, true);
  assert.ok(ordered.xml.indexOf('<p:notesMasterIdLst>') < ordered.xml.indexOf('<p:sldIdLst>'));
  assert.ok(ordered.xml.indexOf('</p:sldMasterIdLst>') < ordered.xml.indexOf('<p:notesMasterIdLst>'));
  assert.equal(orderPresentationLists(ordered.xml).changed, false);
});

const run = (face) =>
  `<a:defRPr sz="1100"><a:solidFill><a:srgbClr val="5A6B7B"/></a:solidFill><a:latin typeface="${face}" pitchFamily="34" charset="0"/></a:defRPr>`;
const chart = (body) =>
  `<c:chartSpace><c:chart><c:plotArea><c:barChart><c:catAx><c:txPr><a:p><a:pPr>${body}</a:pPr></a:p></c:txPr></c:catAx></c:barChart></c:plotArea></c:chart><c:spPr><a:noFill/></c:spPr><c:externalData r:id="rId1"/></c:chartSpace>`;

test('chart runs get East Asian and complex-script faces matching their latin face', () => {
  const { xml, changed, face } = normalizeChartFonts(chart(run('Noto Sans KR')));
  assert.equal(face, 'Noto Sans KR');
  assert.ok(changed >= 2, 'the run and the chart-level default both changed');
  assert.match(
    xml,
    /<a:latin typeface="Noto Sans KR"[^>]*\/><a:ea typeface="Noto Sans KR"[^>]*\/><a:cs typeface="Noto Sans KR"[^>]*\/>/
  );
  assert.match(
    xml,
    /<\/c:spPr><c:txPr>[\s\S]*<a:latin typeface="Noto Sans KR"\/><a:ea typeface="Noto Sans KR"\/>[\s\S]*<\/c:txPr><c:externalData/,
    'the chart default sits after c:spPr and before c:externalData'
  );
  const again = normalizeChartFonts(xml);
  assert.equal(again.changed, 0, 'idempotent: a run that already carries a:ea is left alone');
});

test('a chart without any explicit face is left untouched', () => {
  const plain = '<c:chartSpace><c:chart><c:plotArea/></c:chart></c:chartSpace>';
  assert.deepEqual(normalizeChartFonts(plain), { xml: plain, changed: 0, face: '' });
});

test('existing chart script faces survive normalization without duplicate or out-of-order font elements', () => {
  for (const existing of [
    '\n  <a:cs    typeface="Traditional Arabic"/>',
    '\n  <a:ea typeface="Noto Serif KR"/>\n  <a:cs typeface="Traditional Arabic"/>',
    '<a:ea typeface="Noto Serif KR"/><a:cs typeface="Traditional Arabic"/><a:cs typeface="Traditional Arabic"/>',
  ]) {
    const input = chart(`<a:defRPr><a:latin typeface="Noto Sans KR"/>${existing}</a:defRPr>`);
    const normalized = normalizeChartFonts(input);
    const properties = normalized.xml.match(/<a:defRPr>([\s\S]*?)<\/a:defRPr>/)[1];
    assert.equal((properties.match(/<a:ea\b/g) || []).length, 1);
    assert.equal((properties.match(/<a:cs\b/g) || []).length, 1);
    assert.match(properties, /<a:ea\b[^>]*\/>\s*<a:cs\b[^>]*typeface="Traditional Arabic"/);
    if (existing.includes('Noto Serif KR')) assert.match(properties, /typeface="Noto Serif KR"/);
    assert.equal(normalizeChartFonts(normalized.xml).changed, 0);
  }
});

test('chart children are put in schema order: axis tail, series points, chart-level flags', () => {
  const xml =
    '<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:dLbls><c:showVal val="1"/></c:dLbls><c:dPt><c:idx val="2"/></c:dPt><c:cat/><c:val/></c:ser><c:varyColors val="0"/><c:gapWidth val="60"/><c:axId val="1"/></c:barChart>' +
    '<c:catAx><c:axId val="1"/><c:tickLblSkip val="1"/><c:crossAx val="2"/><c:noMultiLvlLbl val="0"/></c:catAx>';
  const ordered = orderChartChildren(xml);
  assert.equal(ordered.changed, true);
  assert.match(ordered.xml, /<c:barDir val="col"\/><c:varyColors val="0"\/><c:ser>/);
  assert.match(ordered.xml, /<c:order val="0"\/><c:dPt><c:idx val="2"\/><\/c:dPt><c:dLbls>/);
  assert.match(ordered.xml, /<c:crossAx val="2"\/><c:tickLblSkip val="1"\/><c:noMultiLvlLbl/);
  assert.equal(orderChartChildren(ordered.xml).changed, false);
  const line = orderChartChildren(
    '<c:lineChart><c:varyColors val="0"/><c:ser><c:idx val="0"/></c:ser><c:marker val="1"/><c:axId val="1"/></c:lineChart>'
  );
  assert.match(line.xml, /^<c:lineChart><c:grouping val="standard"\/><c:varyColors val="0"\/><c:ser>/);
});

test('the accent overlay series merges into one series with a per-point fill', () => {
  const ser = (name, values, color) =>
    `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>x</c:f><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:val><c:numRef><c:numCache>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`;
  const xml = `<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>${ser('처리량', [12, 18, 0], 'E7EBEE')}${ser('처리량 ·', [0, 0, 31], 'B81E38')}<c:overlap val="100"/></c:barChart>`;
  const merged = mergeAccentSeries(xml);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.accent, [2]);
  assert.equal((merged.xml.match(/<c:ser>/g) || []).length, 1);
  assert.match(merged.xml, /<c:dPt><c:idx val="2"\/>[\s\S]*B81E38/);
  assert.match(merged.xml, /<c:pt idx="2"><c:v>31<\/c:v>/);
  assert.match(merged.xml, /<c:grouping val="clustered"\/>/);
});

test('replacement patterns in a series name are written literally when the accent series merge', () => {
  const ser = (name, values, color) =>
    `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>x</c:f><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:val><c:numRef><c:numCache>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`;
  const xml = `<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>${ser('A$&B', [12, 18, 0], 'E7EBEE')}${ser('A$&B ·', [0, 0, 31], 'B81E38')}<c:overlap val="100"/></c:barChart>`;
  const merged = mergeAccentSeries(xml);
  assert.equal(merged.changed, true);
  assert.equal((merged.xml.match(/A\$&B/g) || []).length, 1);
  assert.equal((merged.xml.match(/<c:ser>/g) || []).length, 1);
});

test('a gradient-marked shape is saved as a native gradFill without an outline, and the marker is cleared', () => {
  const spec = encodeURIComponent(
    JSON.stringify({
      stops: [
        [0, '0B1B2B', 1],
        [100, '1F3A5F', 0.4],
      ],
      angle: 90,
    })
  );
  const shape = (name, fill) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln w="12700"><a:solidFill><a:srgbClr val="0B1B2B"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`;
  const xml = `<p:spTree>${shape(`mixdog-gradient:${spec}`, '<a:solidFill><a:srgbClr val="0B1B2B"/></a:solidFill>')}${shape('Plain', '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>')}</p:spTree>`;
  const { xml: out, changed } = nativeGradients(xml);
  assert.equal(changed, 1);
  assert.match(out, /name="Gradient"/);
  assert.doesNotMatch(out, /mixdog-gradient:/);
  assert.match(
    out,
    /<\/a:prstGeom><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="0B1B2B"\/><\/a:gs><a:gs pos="100000"><a:srgbClr val="1F3A5F"><a:alpha val="40000"\/><\/a:srgbClr><\/a:gs><\/a:gsLst><a:lin ang="5400000" scaled="0"\/><\/a:gradFill><a:ln><a:noFill\/><\/a:ln><\/p:spPr>/
  );
  assert.match(
    out,
    /name="Plain"[\s\S]*?<a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill><a:ln w="12700">/,
    'an unmarked shape keeps its fill and outline'
  );
  assert.equal(nativeGradients(out).changed, 0, 'idempotent');
  const radial = gradientFillXml({
    stops: [
      [0, 'FFAA00', 0.35],
      [100, 'FFAA00', 0],
    ],
    radial: { fx: 0.25, fy: 0.5 },
  });
  assert.match(radial, /<a:path path="circle"><a:fillToRect l="25000" t="50000" r="75000" b="50000"\/><\/a:path>/);
  assert.match(radial, /<a:gs pos="100000"><a:srgbClr val="FFAA00"><a:alpha val="0"\/>/);
});
