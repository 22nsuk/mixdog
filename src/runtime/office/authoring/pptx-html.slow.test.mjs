import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localBrowserAvailable } from '../../shared/browser-launch.mjs';
import { runPptxHtmlAuthoring, htmlArtifacts } from './pptx-html-runner.mjs';
import { measureHtmlDeck } from './pptx-html-measure.mjs';

const DECK = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
.slide { position: relative; width: 1920px; height: 1080px; background: #F4F5F7; font-family: 'Noto Sans KR';
  word-break: keep-all; overflow-wrap: break-word; }
.abs { position: absolute; }
.p { left: 96px; top: 200px; width: 420px; font-size: 32px; line-height: 1.5; color: #14181F; }
.disc { left: 700px; top: 380px; width: 44px; height: 44px; border-radius: 50%; background: #FF6B3D;
  display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; line-height: 1; }
.ic { left: 900px; top: 200px; width: 64px; height: 64px; color: #0F3B3A; }
table { position: absolute; left: 96px; top: 600px; width: 600px; border-collapse: collapse; }
td { font-size: 28px; padding: 10px; border-bottom: 1px solid #C9CDD4; }
.chart { left: 1000px; top: 500px; width: 700px; height: 300px; }
</style></head><body>
<section class="slide">
  <p class="abs p">같은 모델에 같은 과제를 주고 하네스만 바꿨다</p>
  <div class="abs disc">2</div>
  <i class="abs ic" data-icon="coins"></i>
  <table><tr><td>비용</td><td>$0.476</td></tr><tr><td>컨텍스트</td><td>18.5k</td></tr></table>
  <div class="abs chart" data-chart='{"type":"bar","labels":["A","B"],"values":[1,2]}'></div>
  <aside class="notes">발표자 노트</aside>
</section>
</body></html>`;

test('the browser lays the HTML out and the runner writes an editable deck', { skip: !localBrowserAvailable() && 'no local Chrome or Edge' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-html-'));
  try {
    const target = join(dir, 'deck.pptx');
    const artifacts = htmlArtifacts(target);
    const measure = await measureHtmlDeck(DECK, { sourcePath: artifacts.source, shotPath: artifacts.shot });
    const items = measure.slides[0].items;
    const paragraph = items.find((item) => item.kind === 'text' && item.lines.length > 1);
    assert.ok(paragraph, 'the 420 px column wraps the sentence');
    const words = '같은 모델에 같은 과제를 주고 하네스만 바꿨다'.split(' ');
    for (const line of paragraph.lines) {
      const text = line.runs.map((run) => run.text).join('');
      for (const part of text.split(' ')) assert.ok(words.includes(part), `"${part}" is a whole word (keep-all)`);
    }
    const disc = items.find((item) => item.kind === 'text' && item.frame?.radius === 22);
    assert.ok(disc, 'the disc is a framed text item with a full radius');
    assert.ok(items.some((item) => item.kind === 'svg' && item.alt === 'coins'), 'the data-icon became an inline svg');
    assert.equal(items.filter((item) => item.kind === 'table').length, 1);
    assert.equal(items.filter((item) => item.kind === 'chart').length, 1);
    assert.equal(measure.slides[0].notes, '발표자 노트');
    assert.equal(measure.shots.length, 1);

    const staged = join(dir, 'staged.pptx');
    const run = await runPptxHtmlAuthoring(DECK, staged, { target });
    assert.equal(run.ok, true, JSON.stringify(run.error));
    assert.equal(run.kit, 'html');
    assert.ok((await stat(staged)).size > 0);
    assert.ok((await stat(run.htmlSource)).size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a deck page that is not 1920×1080 is refused with the size it measured', { skip: !localBrowserAvailable() && 'no local Chrome or Edge' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-html-'));
  try {
    const target = join(dir, 'deck.pptx');
    const run = await runPptxHtmlAuthoring(
      '<section class="slide" style="width:1280px;height:720px">x</section>',
      join(dir, 'staged.pptx'),
      { target }
    );
    assert.equal(run.ok, false);
    assert.match(run.error.message, /1280×720/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
