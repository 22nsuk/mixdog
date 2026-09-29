// Where a line of words breaks, for the writers that break lines themselves (the PDF writer, a composed sheet's bands).

// Two words that read as one stay on one line: a date, a fraction, or a time in two words ("10월 14일", "3분의 1",
// "14시 30분"), a sum written in two groups ("12만 6천 원", "1억 3,500만 원"), and a sum with its unit ("24억 원").
// Broken between them, a decision read "…을 10월 / 14일 투자심의에서" and a saving "12만 / 6천 원".
function bound(left, right) {
  return (
    (/\d(?:분의|월|시|조|억|만)$/.test(left) && /^\d/.test(right)) || (/\d[억만천조]?$/.test(left) && /^원/.test(right))
  );
}

// A line's words with each pair that reads as one joined by its space: the units a line is broken between.
export function wrapUnits(words) {
  const units = [];
  for (const word of words) {
    const last = units.at(-1);
    if (last !== undefined && bound(last.slice(last.lastIndexOf(' ') + 1), word)) {
      units[units.length - 1] = `${last} ${word}`;
    } else units.push(word);
  }
  return units;
}

// A paragraph's lines without a runt: a last line of one word under a line of three or more takes the word before it
// along, when the pair fits and the line above stays the longer, as the slide kit sets its text — a report's title read
// "…부산 허브 증설이 / 필요합니다". The line count stays. `width(text)` measures one line against `limit`.
export function withoutRunt(lines, width, limit) {
  const last = lines.at(-1) ?? '';
  if (lines.length < 2 || !last.trim() || wrapUnits(last.split(' ')).length !== 1) return lines;
  const above = wrapUnits(lines.at(-2).split(' '));
  if (above.length < 3) return lines;
  const moved = `${above.at(-1)} ${last}`;
  const rest = above.slice(0, -1).join(' ');
  if (width(moved) > limit || width(rest) < width(moved)) return lines;
  return [...lines.slice(0, -2), rest, moved];
}
