import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { clearWorksheetCell, deleteWorksheetNote } from './portable-xlsx-sheet-edits.mjs';
import { deleteDocxComment } from './portable-docx-edits.mjs';
import { writeHeaderFooterPart } from './portable-docx-parts.mjs';
import { copySlideNotes, ensureSlideComments, readSlideNotes } from './portable-pptx-package.mjs';
import { setTableValues } from './portable-pptx-core.mjs';
import { fillTemplateParts, zipText } from './portable-opc.mjs';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (type, target) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/${type}" Target="${target}"/></Relationships>`;

test('clearing a self-closing cell leaves the next cell alone', () => {
  const zip = new JSZip();
  const xml = '<sheetData><row r="1"><c r="A1" s="1"/><c r="B1"><v>2</v></c></row></sheetData>';
  const result = clearWorksheetCell(zip, { path: 'xl/worksheets/sheet1.xml', name: 'S' }, xml, {
    op: 'clear_cell',
    cell: 'A1',
  });
  assert.equal(result.changed, true);
  return zip
    .file('xl/worksheets/sheet1.xml')
    .async('string')
    .then((next) => {
      assert.equal(next, '<sheetData><row r="1"><c r="B1"><v>2</v></c></row></sheetData>');
    });
});

test('deleting a worksheet note follows a root-absolute comments target', async () => {
  const zip = new JSZip();
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', rels('comments', '/xl/comments1.xml'));
  zip.file('xl/comments1.xml', '<comments><commentList><comment ref="A1"><text/></comment></commentList></comments>');
  const result = await deleteWorksheetNote(zip, { path: 'xl/worksheets/sheet1.xml', name: 'S' }, '', {
    op: 'delete_note',
    cell: 'A1',
  });
  assert.equal(result.changed, true);
  assert.doesNotMatch(await zipText(zip, 'xl/comments1.xml'), /<comment ref/);
});

test('deleting a comment removes a reference run that carries attributes', async () => {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  );
  zip.file('word/_rels/document.xml.rels', rels('comments', 'comments.xml'));
  zip.file(
    'word/comments.xml',
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="a"><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:comment></w:comments>'
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="x"><w:body><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>t</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r w:rsidR="00AA"><w:commentReference w:id="1"/></w:r></w:p></w:body></w:document>'
  );
  await deleteDocxComment(zip, { op: 'delete_comment', comment: 1 });
  assert.doesNotMatch(await zipText(zip, 'word/document.xml'), /commentReference|w:rsidR/);
});

test('a root-absolute header target is rewritten in place', async () => {
  const zip = new JSZip();
  zip.file('word/_rels/document.xml.rels', rels('header', '/word/header1.xml'));
  zip.file('word/header1.xml', '<w:hdr xmlns:w="w"><w:p/></w:hdr>');
  const documentXml = '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>';
  const result = await writeHeaderFooterPart(zip, {
    header: true,
    body: '<w:p>new</w:p>',
    documentXml,
    kind: 'default',
  });
  assert.equal(result.part, 'word/header1.xml');
  assert.equal(zip.file('word/word/header1.xml'), null);
  assert.match(await zipText(zip, 'word/header1.xml'), /new/);
});

test('slide notes and comments resolve root-absolute relationship targets', async () => {
  const zip = new JSZip();
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels('notesSlide', '/ppt/notesSlides/notesSlide1.xml'));
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><p:sp><p:ph type="body"/><a:t>spoken</a:t></p:sp></p:notes>');
  assert.equal(await readSlideNotes(zip, { path: 'ppt/slides/slide1.xml' }), 'spoken');
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  );
  await copySlideNotes(zip, 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml');
  assert.ok(zip.file('ppt/notesSlides/notesSlide2.xml'));
  const commented = new JSZip();
  commented.file('ppt/slides/_rels/slide1.xml.rels', rels('comments', '/ppt/comments/comment1.xml'));
  assert.equal(await ensureSlideComments(commented, { path: 'ppt/slides/slide1.xml' }), 'ppt/comments/comment1.xml');
});

test('a null row in table values is skipped instead of throwing', () => {
  const cell = '<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc>';
  const shape = `<p:graphicFrame><a:tbl><a:tblGrid><a:gridCol w="100"/></a:tblGrid><a:tr h="1">${cell}</a:tr><a:tr h="1">${cell}</a:tr></a:tbl></p:graphicFrame>`;
  const result = setTableValues(shape, [['a'], null]);
  assert.ok(result);
});

test('fill_template reports strict the way it enforces it', async () => {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>{{a}}</a:t></a:r></a:p></p:sld>');
  const result = await fillTemplateParts(zip, ['ppt/slides/slide1.xml'], 'a:t', { tokens: { a: 'x' }, strict: 'yes' });
  assert.equal(result.strict, true);
});
