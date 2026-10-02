import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool } from '../index.mjs';
import { value, workspace } from '../office-test-support.mjs';
import { localBrowserAvailable } from '../../shared/browser-launch.mjs';

const skip = !localBrowserAvailable() && 'no local Chrome or Edge';

const DECK = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<!-- BRIEF
subject/audience/action: 재작성 검사 / 운영팀 / 확인
facts: sample — 검사용 덱
-->
<style>.slide { position: relative; width: 1920px; height: 1080px; background: #F6F8F7; font-family: 'Noto Sans KR'; }
.t { position: absolute; left: 96px; top: 400px; width: 1200px; margin: 0; font-size: 64px; font-weight: 700; color: #14201C; }</style>
</head><body><section class="slide"><p class="t">첫 번째 제목</p></section></body></html>`;

const slideText = async (path) =>
  (await (await JSZip.loadAsync(await readFile(path))).file('ppt/slides/slide1.xml').async('string'))
    .match(/<a:t>([^<]*)<\/a:t>/g)
    .join('');

test('a deck authored from HTML is authored again from its kept source when no script is given', {
  skip,
}, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'deck.pptx');
  const first = value(
    await executeOfficeTool({ action: 'author', path, script: DECK, mode: 'portable', render: false }, { cwd })
  );
  assert.equal(first.ok, true, JSON.stringify(first.error));
  await executeOfficeTool({ action: 'close', session: first.session }, { cwd });
  // The fix is an edit to the kept HTML; no session holds the deck, and no overwrite is needed.
  const source = `${path}.mixdog-source.html`;
  await writeFile(source, (await readFile(source, 'utf8')).replace('첫 번째 제목', '고친 제목'));
  const again = value(await executeOfficeTool({ action: 'author', path, mode: 'portable', render: false }, { cwd }));
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.match(await slideText(path), /고친 제목/);
  await executeOfficeTool({ action: 'close', session: again.session }, { cwd });
});

test('a batch edit on a deck from HTML says the HTML no longer holds it, and the next author says it was replaced', {
  skip,
}, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'edited.pptx');
  const first = value(
    await executeOfficeTool({ action: 'author', path, script: DECK, mode: 'portable', render: false }, { cwd })
  );
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: first.session,
        operations: [{ op: 'replace_text', slide: 1, find: '첫 번째 제목', replace: '덱에서 고친 제목' }],
      },
      { cwd }
    )
  );
  assert.equal(edited.htmlSource?.current, false, JSON.stringify(edited.htmlSource));
  assert.equal(edited.htmlSource.editsSinceAuthor, 1);
  assert.match(edited.htmlSource.note, /drops them/);
  const again = value(await executeOfficeTool({ action: 'author', path, mode: 'portable', render: false }, { cwd }));
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(again.replacedEdits?.count, 1, JSON.stringify(again.replacedEdits));
  assert.match(await slideText(path), /첫 번째 제목/, 'the rebuild is the HTML, without the batch edit');
  // The count starts again from the new file.
  const clean = value(await executeOfficeTool({ action: 'author', path, mode: 'portable', render: false }, { cwd }));
  assert.equal(clean.replacedEdits, undefined);
  await executeOfficeTool({ action: 'close', session: clean.session }, { cwd });
});

test('author with no script and no kept source asks for the script', { skip }, async (t) => {
  const cwd = await workspace(t);
  const refused = await executeOfficeTool(
    { action: 'author', path: join(cwd, 'none.pptx'), mode: 'portable' },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /mixdog-source\.html, and none is there/);
});
