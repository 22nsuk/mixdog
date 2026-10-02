import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewOfficeStructure } from './assurance-structure.mjs';

// One slide with a two-line body paragraph at `size` pt and a one-line source note at `note` pt.
const deck = (width, height, size, note, extra = {}) => ({
  slideWidth: width,
  slideHeight: height,
  ...extra,
  slides: [
    {
      path: '/slide[1]',
      index: 1,
      notes: '',
      shapes: [
        {
          path: '/slide[1]/shape[1]',
          index: 1,
          text: '본문 문단의 첫째 줄입니다.\n둘째 줄도 본문입니다.',
          left: 40,
          top: 60,
          width: 400,
          height: 60,
          font: { size },
        },
        {
          path: '/slide[1]/shape[2]',
          index: 2,
          text: '출처: 운영 시스템',
          left: 40,
          top: height - 80,
          width: 300,
          height: 16,
          font: { size: note },
        },
      ],
    },
  ],
});
const small = (document) =>
  reviewOfficeStructure({ format: 'pptx', document })
    .filter((entry) => entry.code === 'small_font')
    .map((entry) => entry.path);

test('a 4:3 slide keeps the wide deck floors: the two share the 7.5 in height a screen fits them to', () => {
  assert.deepEqual(small(deck(960, 540, 11, 8.5)), ['/slide[1]/shape[1]', '/slide[1]/shape[2]']);
  assert.deepEqual(
    small(deck(720, 540, 11, 8.5)),
    ['/slide[1]/shape[1]', '/slide[1]/shape[2]'],
    '4:3 body under 12 pt is small'
  );
  assert.deepEqual(small(deck(720, 540, 12, 9)), []);
});

test('a shorter canvas is enlarged on screen, so its floors scale with its height', () => {
  // 10 × 5.625 in (720 × 405 pt): 12 pt and 9 pt read as 9 pt and 7 pt.
  assert.deepEqual(small(deck(720, 405, 9, 7)), []);
  assert.deepEqual(small(deck(720, 405, 8.5, 6.5)), ['/slide[1]/shape[1]', '/slide[1]/shape[2]']);
});

test('a printed sheet is held to the print floors whatever its size: body 9 pt, one-line notes 7 pt', () => {
  const a4 = (size, note) => deck(595, 842, size, note, { printSheet: true });
  assert.deepEqual(small(a4(9.5, 7.5)), []);
  assert.deepEqual(small(a4(8.5, 6.5)), ['/slide[1]/shape[1]', '/slide[1]/shape[2]']);
  // The same A4 page as a slide would hold 12 pt body: the medium decides, not the page's width.
  assert.deepEqual(small(deck(595, 842, 9.5, 7.5)), ['/slide[1]/shape[1]', '/slide[1]/shape[2]']);
});
