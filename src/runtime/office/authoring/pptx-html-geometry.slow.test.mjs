import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localBrowserAvailable } from '../../shared/browser-launch.mjs';
import { htmlArtifacts } from './pptx-html-runner.mjs';
import { measureHtmlDeck } from './pptx-html-measure.mjs';

const ARROW = '<path d="M10 20 H90 M74 6 L90 20 L74 34" stroke="#161A33" stroke-width="4" fill="none"/>';
const DECK = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
.slide { position: relative; width: 1920px; height: 1080px; background: #F4F5F9; font-family: 'Noto Sans KR'; }
.abs { position: absolute; }
.card { width: 500px; height: 280px; background: #FFFFFF; }
.spec { width: 500px; height: 100px; border-top: 2px solid #161A33; }
.dot { width: 36px; height: 36px; border-radius: 50%; background: #FFFFFF; border: 8px solid #232A6B; }
</style></head><body>
<section class="slide">
  <div class="abs card" style="left:96px;top:300px"></div>
  <div class="abs card" style="left:760px;top:260px"></div>
  <svg class="abs" style="left:628px;top:500px;width:100px;height:40px" viewBox="0 0 100 40">${ARROW}</svg>
  <div class="abs spec" style="left:118px;top:700px"></div>
</section>
<section class="slide">
  <svg class="abs" style="left:96px;top:230px;width:980px;height:740px" viewBox="0 0 980 740">
    <circle id="big" cx="470" cy="380" r="350" fill="#E3E6F7"/><circle cx="560" cy="470" r="240" fill="#C9CEF2" data-inside="big"/>
  </svg>
</section>
<section class="slide">
  <svg class="abs" style="left:96px;top:230px;width:980px;height:740px" viewBox="0 0 980 740">
    <circle cx="470" cy="380" r="350" fill="#E3E6F7"/><circle cx="560" cy="470" r="240" fill="#C9CEF2"/>
  </svg>
</section>
<section class="slide">
  <div class="abs" style="left:0;top:200px;width:1920px;height:200px;background:#C9CEF2;clip-path:polygon(0 78%,100% 0,100% 22%,0 100%)"></div>
  <div class="abs dot" style="left:300px;top:330px"></div>
  <svg class="abs" style="left:0;top:700px;width:1920px;height:100px" viewBox="0 0 1920 100"><line id="band" x1="0" y1="80" x2="1920" y2="20" stroke="#C9CEF2" stroke-width="20"/></svg>
  <div class="abs dot" data-on="band" style="left:942px;top:752px"></div>
  <div class="abs" style="left:1400px;top:705px;width:400px;font-size:24px;line-height:1.3">밴드에 걸친 설명</div>
</section>
<section class="slide">
  <div class="abs card" id="ca" style="left:96px;top:300px"></div>
  <div class="abs card" id="cb" style="left:760px;top:300px"></div>
  <svg class="abs" data-between="ca cb" style="left:628px;top:420px;width:100px;height:40px" viewBox="0 0 100 40">${ARROW}</svg>
  <div class="abs spec" data-align="left ca, right ca" style="left:96px;top:700px"></div>
  <svg class="abs" style="left:1300px;top:300px;width:500px;height:500px" viewBox="0 0 500 500">
    <circle id="outer" cx="250" cy="250" r="240" fill="#E3E6F7"/><circle id="inner" cx="330" cy="330" r="120" fill="#C2461A" data-inside="outer"/>
  </svg>
  <div class="abs" data-label="inner" style="left:1570px;top:600px;width:120px;height:60px;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;color:#FFFFFF">목표</div>
  <svg class="abs" style="left:0;top:850px;width:1920px;height:100px" viewBox="0 0 1920 100"><line id="road" x1="0" y1="80" x2="1920" y2="20" stroke="#C9CEF2" stroke-width="20"/></svg>
  <div class="abs dot" data-on="road" style="left:942px;top:882px"></div>
</section>
<section class="slide">
  <svg class="abs" style="left:0;top:600px;width:1920px;height:200px" viewBox="0 0 1920 200"><polygon points="0,100 1920,100 1920,200 0,200" fill="#C9CEF2"/></svg>
  <div class="abs" style="left:200px;top:660px;width:600px;font-size:24px;line-height:1.3">띠 바로 위에 붙은 설명</div>
</section>
</body></html>`;

test('the geometry read refuses the misses a page makes and passes the relations that hold', { skip: !localBrowserAvailable() && 'no local Chrome or Edge' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-geometry-'));
  try {
    const artifacts = htmlArtifacts(join(dir, 'deck.pptx'));
    const { geometry } = await measureHtmlDeck(DECK, { sourcePath: artifacts.source, shotPath: artifacts.shot });
    const page = (n) => geometry.find((entry) => entry.slide === n)?.findings || [];
    const checks = (n) => page(n).map((finding) => finding.check).sort();
    const off = (n, check) => page(n).find((finding) => finding.check === check)?.off;

    // An arrow under the midline of staggered cards, and a block 22 px out of the column above it.
    assert.deepEqual(checks(1), ['connector', 'near_miss']);
    assert.equal(off(1, 'connector'), 100);
    assert.equal(off(1, 'near_miss'), 22);
    // A circle declared inside another, and the same circle undeclared, both reach 17 px past the edge.
    assert.deepEqual(checks(2), ['inside']);
    assert.ok(Math.abs(off(2, 'inside') - 17.3) < 0.2, JSON.stringify(page(2)));
    assert.deepEqual(checks(3), ['containment']);
    // A dot set on a clipped band with no relation, and a dot declared on a line but 20 px below it.
    // ...and a caption whose lower half runs onto the drawn line (its box clears the line's frame nowhere).
    assert.deepEqual(checks(4), ['marker', 'on', 'text_on_drawing']);
    assert.ok(Math.abs(off(4, 'on') - 20) < 0.5, JSON.stringify(page(4)));
    // The same page with every related position computed: nothing to report.
    assert.deepEqual(page(5), []);
    // Words clear of a band by less than 8 px, though they touch none of it.
    assert.deepEqual(checks(6), ['text_on_drawing']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
