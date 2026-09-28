import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { pptxReviewArtifacts } from './pptx-review-artifacts.mjs';

// A deck of up to four slides arrives as page images the reader sees in order;
// the contact sheet is written for it but its pixels are not attached again.
test('the contact sheet image rides along only past four slides, and its file is always written', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-contact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const page = async (index) => ({
    page: index,
    path: join(dir, `page-${index}.png`),
    data: (await sharp({ create: { width: 64, height: 36, channels: 3, background: '#e0e4ea' } }).png().toBuffer()).toString('base64'),
    mimeType: 'image/png',
  });
  const preview = async (count) => ({
    output: join(dir, `deck-${count}.pdf`),
    pageCount: count,
    _images: await Promise.all(Array.from({ length: count }, (_, i) => page(i + 1))),
  });
  const session = { id: 'fixture', format: 'pptx' };
  const short = await pptxReviewArtifacts(session, await preview(3));
  assert.ok(short.contactSheet?.path, 'the sheet file is written');
  assert.equal(short._images.length, 3, 'three page images, no sheet image');
  const long = await pptxReviewArtifacts(session, await preview(6));
  assert.equal(long._images.length, 7, 'six page images and the sheet');
  assert.equal(long._images.at(-1).page, 0);
});
