// Laying out a range of cells that already exists: sort_range reorders its
// rows, autofit_range measures the width each column prints. Both read the
// cell grid and write it back; neither adds a part to the package.
import {
  cellRecords,
  cellStyleIndexes,
  columnLabel,
  columnNumber,
  expandRange,
  iterateSheetCells,
  parseCellRef,
  setCellStylesInSheet,
  setCellsInSheet,
  sharedStrings,
} from './portable-cells.mjs';
import { zipText } from './portable-opc.mjs';
import { expandSharedFormulas } from './portable-shared-formulas.mjs';
import { sortedFormula } from './portable-xlsx-reference-shift.mjs';
import { UnsupportedFormula } from './xlsx-formula-engine.mjs';
import { resolveCellStyles } from './portable-sheet-styles.mjs';
import { columnFileWidth, maximumDigitWidth, textCharacters } from './portable-sheet-page.mjs';
import {
  cellWidthScale,
  displayWidth,
  formattedNumberWidth,
  hiddenSheetAreas,
  mergedRanges,
  parseAreaRange,
  writeColumnWidths,
} from './portable-sheet-xml.mjs';

// The sort key is named the way the caller already reads the sheet: a column
// letter, the header the column carries, or nothing when the first column of
// the range is the key.
function sortKeyColumn(op, area, headerValue) {
  const declared = String(op.by ?? op.column ?? op.byColumn ?? '').trim();
  if (!declared) return area.startCol;
  if (/^[A-Za-z]{1,3}$/.test(declared)) {
    const column = columnNumber(declared.toUpperCase());
    if (column < area.startCol || column > area.endCol) {
      throw new Error(`XLSX sort_range by "${declared}" is outside ${op.range}; name a column the range covers.`);
    }
    return column;
  }
  const headers = [];
  for (let col = area.startCol; col <= area.endCol; col += 1) {
    const value = headerValue(col);
    const text = value == null ? '' : String(value).trim();
    if (text) headers.push(`${columnLabel(col)} (${text})`);
    if (text && text === declared) return col;
  }
  throw new Error(
    `XLSX sort_range by "${declared}" matches no column in ${op.range}. Name a column letter or one of its headers: ${headers.join(', ') || '(the range has no header row)'}.`
  );
}

// Excel orders numbers before text and leaves blanks last in both directions;
// text is compared the way the reader's locale reads it, so 강릉 sorts before
// 광주 rather than by code point.
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareSortValues(left, right) {
  const blank = (value) => value == null || value === '';
  if (blank(left) && blank(right)) return 0;
  if (blank(left)) return 1;
  if (blank(right)) return -1;
  const leftNumber = typeof left === 'number' ? left : Number(left);
  const rightNumber = typeof right === 'number' ? right : Number(right);
  const leftNumeric = typeof left === 'number' || (String(left).trim() !== '' && Number.isFinite(leftNumber));
  const rightNumeric = typeof right === 'number' || (String(right).trim() !== '' && Number.isFinite(rightNumber));
  if (leftNumeric && rightNumeric) return leftNumber - rightNumber;
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return SORT_COLLATOR.compare(String(left), String(right));
}

// The sorts Excel itself refuses, and the ones that would silently corrupt
// the sheet: a formula stored once for cells the sort would split, hidden
// rows among the moved ones, and merged cells crossing them.
function refuseUnsortableRange(xml, area, firstRow) {
  // A formula filled down is stored once for the whole run, and an array formula once for its block: moving one row
  // of either rewrites the others. Excel refuses to change part of an array.
  const inBody = (ref) => {
    const at = parseCellRef(ref);
    const column = columnNumber(at.col);
    return at.row >= firstRow && at.row <= area.endRow && column >= area.startCol && column <= area.endCol;
  };
  const groups = new Map();
  for (const cell of iterateSheetCells(xml)) {
    const attributes = /<f\b([^>]*?)\/?>/.exec(cell.body)?.[1];
    if (attributes === undefined) continue;
    if (/\bt="array"/.test(attributes) && inBody(cell.ref)) {
      throw new Error(
        `XLSX sort_range cannot move the array formula at ${cell.ref}; Excel refuses to change part of an array. Sort a range without it.`
      );
    }
    const id = /\bt="shared"/.test(attributes) ? /\bsi="([^"]+)"/.exec(attributes)?.[1] : undefined;
    if (id === undefined) continue;
    const group = groups.get(id) || { inside: [], outside: [] };
    (inBody(cell.ref) ? group.inside : group.outside).push(cell.ref);
    groups.set(id, group);
  }
  const split = [...groups.values()].find((group) => group.inside.length && group.outside.length);
  if (split) {
    throw new Error(
      `XLSX sort_range would move part of a formula filled down as one, ${split.inside[0]} through ${split.outside.at(-1)}. Sort the whole filled range, or write the formula into each row with set_formula first.`
    );
  }
  // A filtered sheet hides rows, not records: the flag stays on the row
  // number while the values move under it, so a sort would leave a
  // different record hidden than the one the reader filtered away.
  const withheld = [...hiddenSheetAreas(xml).rows].filter((row) => row >= firstRow && row <= area.endRow);
  if (withheld.length) {
    throw new Error(
      `XLSX sort_range would move values under hidden row${withheld.length > 1 ? 's' : ''} ${withheld.slice(0, 5).join(', ')}, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them.`
    );
  }
  // Excel refuses the same case: a merged cell cannot travel with one row.
  const merges = mergedRanges(xml).filter((range) => {
    const merge = expandRange(range);
    return (
      merge.endRow >= firstRow &&
      merge.startRow <= area.endRow &&
      merge.endCol >= area.startCol &&
      merge.startCol <= area.endCol
    );
  });
  if (merges.length) {
    throw new Error(
      `XLSX sort_range cannot move rows through the merged cell${merges.length > 1 ? 's' : ''} ${merges.slice(0, 5).join(', ')}; Excel refuses the same sort. Unmerge them first with unmerge_cells.`
    );
  }
}

// The cell refs of the sortable body, row by row.
function rangeRows(area, firstRow, refAt) {
  return Array.from({ length: area.endRow - firstRow + 1 }, (_unused, offset) => firstRow + offset).map((row) =>
    Array.from({ length: area.endCol - area.startCol + 1 }, (_empty, index) => refAt(row, area.startCol + index))
  );
}

// A formula travels with its row as Excel moves it (sortedFormula); one that cannot be moved refuses the sort.
function writeSortedRows(xml, sorted, area, firstRow, refAt) {
  const placed = sorted.flatMap((cells, offset) =>
    cells.map((cell, index) => ({ ref: refAt(firstRow + offset, area.startCol + index), ...cell }))
  );
  const withValues = setCellsInSheet(
    xml,
    placed.map(({ ref, value, formula, row }) => {
      if (!formula) return { ref, value };
      try {
        return { ref, formula: sortedFormula(formula, parseCellRef(ref).row - row) };
      } catch (error) {
        if (!(error instanceof UnsupportedFormula)) throw error;
        throw new Error(`XLSX sort_range cannot move the formula in ${refAt(row, columnNumber(parseCellRef(ref).col))} (=${formula}): ${error.reason}.`);
      }
    })
  );
  return setCellStylesInSheet(
    withValues,
    placed.map(({ ref, style }) => ({ ref, style }))
  );
}

/** Sorts the values of a range, refusing the cases Excel itself refuses. */
export async function sortWorksheetRange(zip, sheet, xml, op) {
  const area = expandRange(op.range);
  const header = op.hasHeader !== false;
  const firstRow = area.startRow + (header ? 1 : 0);
  const refAt = (row, col) => `${columnLabel(col)}${row}`;
  refuseUnsortableRange(xml, area, firstRow);
  // Each cell of a filled-down run holds its own formula once the run moves whole, as a plain formula Excel reads alike.
  const list = cellRecords(xml, await sharedStrings(zip));
  expandSharedFormulas(xml, list);
  const records = new Map(list.map((cell) => [cell.ref, cell]));
  const column = sortKeyColumn(op, area, (col) => records.get(refAt(area.startRow, col))?.value);
  const descending = String(op.order || 'asc')
    .trim()
    .toLowerCase()
    .startsWith('desc');
  const rows = rangeRows(area, firstRow, refAt);
  const styles = cellStyleIndexes(xml, rows.flat());
  const body = rows.map((refs) =>
    refs.map((ref) => ({
      value: records.get(ref)?.value ?? null,
      formula: records.get(ref)?.formula || '',
      row: parseCellRef(ref).row,
      style: styles.get(ref) || 0,
    }))
  );
  const keyIndex = column - area.startCol;
  const sorted = [...body].sort(
    (left, right) => compareSortValues(left[keyIndex]?.value, right[keyIndex]?.value) * (descending ? -1 : 1)
  );
  zip.file(sheet.path, writeSortedRows(xml, sorted, area, firstRow, refAt));
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    range: op.range,
    by: columnLabel(column),
    order: descending ? 'desc' : 'asc',
    rows: sorted.length,
  };
}

// The widest printed text of each column in the area, skipping the cells a
// horizontal merge spans. A width counts characters of the workbook's default
// size (`baseSize`), so a cell set larger takes proportionally more of it.
// A line of text alone in its row (a sheet title, an instruction under it) prints across the empty cells beside it,
// so a fit over several columns does not size its column to it: a form's "파란 칸에 입력하세요…" under its title set
// column A four times the width of the dates under it and split the table over two pages. A wrapped line keeps its
// column, as does a fit of that one column.
function spillingText(records, area) {
  if (!area.startCol || area.endCol <= area.startCol) return new Set();
  const filled = new Map();
  for (const record of records) {
    // A formula prints its result whether or not the result is cached yet: a label beside a row of formulas not yet
    // calculated is a row label, not a line alone.
    const text = String((record.formula ? record.cachedValue : record.value) ?? '');
    if (!record.formula && !text.trim()) continue;
    const row = parseCellRef(record.ref).row;
    filled.set(row, [...(filled.get(row) || []), record]);
  }
  const spilling = new Set();
  for (const cells of filled.values()) {
    const [only] = cells;
    if (cells.length !== 1 || only.formula || only.style?.wrapText) continue;
    const value = String(only.value ?? '');
    if (only.dataType === 'text' || !Number.isFinite(Number(value))) spilling.add(only.ref);
  }
  return spilling;
}

function measuredColumnWidths(records, area, spans, baseStyle, digitWidth) {
  const baseSize = Number(baseStyle?.fontSize) || 11;
  const measured = new Map();
  const spilling = spillingText(records, area);
  for (const record of records) {
    const parsed = parseCellRef(record.ref);
    const column = columnNumber(parsed.col);
    if (area.startCol && (column < area.startCol || column > area.endCol)) continue;
    if (area.startRow && (parsed.row < area.startRow || parsed.row > area.endRow)) continue;
    if (spilling.has(record.ref)) continue;
    if (
      spans.some(
        (span) =>
          span.startCol !== span.endCol &&
          span.startCol <= column &&
          column <= span.endCol &&
          span.startRow <= parsed.row &&
          parsed.row <= span.endRow
      )
    )
      continue;
    const value = record.formula ? record.cachedValue : record.value;
    const text = String(value ?? '');
    const numeric = record.dataType !== 'text' && text.trim() !== '' && Number.isFinite(Number(text));
    // An indent level holds about one character of the column before the text starts. A cell on the default style
    // carries no record style, and its face is the one the width counts in. A text is measured in its own face, as
    // the fit audit measures it; a figure counts the digits its format prints.
    const needed =
      (numeric
        ? formattedNumberWidth(Number(text), record.style?.numberFormat || '') * cellWidthScale(record.style, baseSize)
        : textCharacters(text, record.style || baseStyle, digitWidth)) + (Number(record.style?.indent) || 0);
    measured.set(column, Math.max(measured.get(column) || 0, needed));
  }
  return measured;
}

/** Widths measured from what each cell prints, with the floor a composed sheet asks for. */
export async function autofitWorksheetRange(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  // A row fit names rows (1:12) and asks for their height. Measuring columns
  // there rewrote every column width from its text, which silently undid the
  // widths a composed layout had just asked for.
  if (op.rows === true && !area.startCol) {
    return { op: op.op, changed: true, sheet: sheet.name, rows: true, columns: 0 };
  }
  // Widths follow what the cell prints: a number carries its format's
  // separators, decimals, and units, not the digits it stores.
  const stylesXml = await zipText(zip, 'xl/styles.xml');
  const cellStyles = resolveCellStyles(stylesXml);
  const records = cellRecords(xml, await sharedStrings(zip), { styles: cellStyles });
  const spans = mergedRanges(xml).map((entry) => parseAreaRange(entry));
  const digitWidth = maximumDigitWidth(stylesXml);
  const measured = measuredColumnWidths(records, area, spans, cellStyles[0], digitWidth);
  // Fit-to-page never enlarges a sheet, so a layout whose columns hold only
  // their text prints as a small block in the corner of the page. minWidth is
  // the floor a composed sheet asks for: the columns still grow to their
  // content, and every column in the range - including the empty ones a
  // merged band spans - reaches that floor so the block keeps its width.
  const floor = Number(op.minWidth) > 0 ? Math.min(80, Number(op.minWidth)) : 8;
  if (Number(op.minWidth) > 0 && area.startCol && area.endCol - area.startCol < 64) {
    for (let column = area.startCol; column <= area.endCol; column += 1) {
      if (!measured.has(column)) measured.set(column, 0);
    }
  }
  // Characters, stored with Excel's cell padding as set_column_width stores them.
  const widths = new Map(
    [...measured.entries()].map(([column, width]) => [
      column,
      columnFileWidth(Math.min(80, Math.max(floor, Math.round((width + 2) * 10) / 10)), digitWidth),
    ])
  );
  zip.file(sheet.path, writeColumnWidths(xml, widths));
  return { op: op.op, changed: true, sheet: sheet.name, columns: widths.size };
}
