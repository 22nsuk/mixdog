// Workbook structure review: sheet layout, formulas, charts and print areas.
import { auditXlsxFormulas } from '../portable/xlsx-formula-audit.mjs';
import { columnNumber as columnIndex } from '../portable/portable-cells.mjs';
import { sheetPath } from '../portable/xlsx-audit-support.mjs';
import { issue } from './assurance-issue.mjs';

function cellRow(ref) {
  return Number(/([1-9]\d*)$/.exec(String(ref || '').replaceAll('$', ''))?.[1] || 0);
}

function formulaRanges(formula) {
  const ranges = [];
  for (const match of String(formula || '').matchAll(/\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)/gi)) {
    ranges.push({
      startColumn: columnIndex(match[1]),
      start: Number(match[2]),
      endColumn: columnIndex(match[3]),
      end: Number(match[4]),
    });
  }
  return ranges;
}

// How far a series may stop above the data before the gap reads as a deliberate
// window rather than as the row someone forgot to include.
const CHART_SHORT_ROWS = 2;

function cellColumn(ref) {
  return columnIndex(/^\$?([A-Z]{1,3})/i.exec(String(ref || ''))?.[1] || '');
}

// A number the sheet holds, whatever notation it wears; a note or a label under
// the table is text and is not data the chart left out.
function numericCell(cell) {
  const raw = String(cell?.value ?? '').trim();
  if (!raw) return false;
  return Number.isFinite(Number(raw.replaceAll(',', '').replace(/%$/, '')));
}

// A print area is one or more A1 ranges; Excel prints each as its own page set.
function printAreas(reference) {
  return String(reference || '')
    .split(',')
    .map((part) => {
      const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(part.trim());
      if (!match) return null;
      return {
        startColumn: columnIndex(match[1]),
        startRow: Number(match[2]),
        endColumn: columnIndex(match[3] || match[1]),
        endRow: Number(match[4] || match[2]),
      };
    })
    .filter(Boolean);
}

// The face a sheet's plain cells wear: the workbook's default where the reading states it, else the commonest.
function baseFace(cells, defaults) {
  if (defaults?.fontName || defaults?.fontSize) return { fontName: defaults.fontName, fontSize: defaults.fontSize };
  const counts = new Map();
  for (const cell of cells) {
    const face = `${cell.style?.fontName ?? ''}\u0000${cell.style?.fontSize ?? ''}`;
    counts.set(face, (counts.get(face) || 0) + 1);
  }
  const [face = '\u0000'] = [...counts].sort((left, right) => right[1] - left[1])[0] || [];
  const [fontName, fontSize] = face.split('\u0000');
  return { fontName, fontSize: fontSize === '' ? undefined : Number(fontSize) };
}

// A cell is styled by what it states beyond that face. The Office reader reports the workbook font (맑은 고딕 11)
// on every cell, which counted a sheet of plain data as styled and kept this check from ever firing there.
function styledCell(style, base) {
  return Object.entries(style || {}).some(([key, value]) => {
    if (key === 'fontName') return Boolean(value) && value !== base.fontName;
    if (key === 'fontSize') return value != null && Number(value) !== Number(base.fontSize);
    if (key === 'color') return !/^(?:#?000000|auto)?$/i.test(String(value ?? ''));
    return value != null && value !== '' && value !== false;
  });
}

function reviewXlsxHierarchy(sheet, cells, issues, defaults) {
  if (cells.length < 8) return;
  const base = baseFace(cells, defaults);
  const styled = cells.filter((cell) => styledCell(cell.style, base));
  if (styled.length) return;
  issues.push(
    issue(
      'worksheet_hierarchy_missing',
      sheetPath(sheet),
      'Data sheet has no styled title, header, table, or visual hierarchy.'
    )
  );
}

function xlsxTotalRows(cells) {
  return new Set(
    cells
      .filter((cell) =>
        /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(cell.value || '').trim())
      )
      .map((cell) => cellRow(cell.ref))
      .filter(Boolean)
  );
}

function reviewXlsxFormulaErrors(sheet, cells, issues) {
  for (const cell of cells) {
    if (!/^#(?:DIV\/0|VALUE|REF|NAME|N\/A|NUM|NULL|SPILL|CALC|FIELD)\??!?$/i.test(String(cell.value || '').trim())) {
      continue;
    }
    issues.push(
      issue(
        'formula_error',
        cell.path || `${sheetPath(sheet)}/cell[${cell.ref || ''}]`,
        `Formula evaluates to ${cell.value}.`,
        'format-review',
        'error'
      )
    );
  }
}

// The last data row the chart's columns hold past the rows it reads; 0 when
// the series reach the data or the columns hold nothing more.
function chartLastMissedRow(cells, ranges, lastRead, totalRows) {
  if (!ranges.length) return 0;
  const first = Math.min(...ranges.map((range) => range.startColumn));
  const last = Math.max(...ranges.map((range) => range.endColumn));
  const missed = cells
    .filter((cell) => {
      const row = cellRow(cell.ref);
      const column = cellColumn(cell.ref);
      return row > lastRead && !totalRows.has(row) && column >= first && column <= last && numericCell(cell);
    })
    .map((cell) => cellRow(cell.ref));
  return missed.length ? Math.max(...missed) : 0;
}

function reviewXlsxChartRanges(sheet, cells, totalRows, issues) {
  for (const chart of sheet.charts || []) {
    const chartPath = chart.path || `${sheetPath(sheet)}/chart`;
    const formulas = (chart.series || [])
      .flatMap((series) => [series.formula, series.categoryFormula, series.valueFormula])
      .filter(Boolean);
    const included = [...totalRows].find((row) =>
      formulas.some((formula) => formulaRanges(formula).some((range) => row >= range.start && row <= range.end))
    );
    if (included) {
      issues.push(
        issue(
          'chart_includes_total_row',
          chartPath,
          `Chart source includes total or subtotal row ${included}; separate summary rows from comparison series.`
        )
      );
    }
    // The opposite error renders just as cleanly: a series that stops one row
    // above the data draws a picture the sheet does not support. A chart
    // showing a deliberate window stops far short, and a total row is left
    // out on purpose, so only the last row or two count.
    const ranges = formulas.flatMap((formula) => formulaRanges(formula));
    const lastRead = ranges.length ? Math.max(...ranges.map((range) => range.end)) : 0;
    const lastData = chartLastMissedRow(cells, ranges, lastRead, totalRows);
    if (lastRead && lastData && lastData - lastRead <= CHART_SHORT_ROWS) {
      issues.push(
        issue(
          'chart_stops_short_of_data',
          chartPath,
          `Chart source stops at row ${lastRead} while the columns it reads hold data through row ${lastData}; widen the series range.`
        )
      );
    }
  }
}

function reviewXlsxPrintFit(sheet, pageSetup, issues) {
  const rows = Number(sheet.rows) || 0;
  const columns = Number(sheet.columns) || 0;
  if (!(rows >= 40 || columns >= 12) || Number(pageSetup.fitToPagesWide) === 1 || !(Number(pageSetup.zoom) > 100)) {
    return;
  }
  issues.push(
    issue(
      'worksheet_print_fit_missing',
      sheetPath(sheet),
      'Large worksheet has no one-page-wide print fit and uses an enlarged print zoom.'
    )
  );
}

function sheetDrawings(sheet) {
  return [
    ...(sheet.charts || []).map((entry) => ({ kind: 'Chart', entry })),
    ...(sheet.images || []).map((entry) => ({ kind: 'Picture', entry })),
  ].filter((item) => Number(item.entry?.anchor?.endColumn) > 0);
}

// A chart or picture the print area leaves out is cut in half by the page
// break, and a sheet with no print area at all paginates around it.
function reviewXlsxPrintArea(sheet, pageSetup, drawings, issues) {
  const areas = printAreas(pageSetup.printArea);
  for (const { kind, entry } of drawings.slice(0, 3)) {
    const anchor = entry.anchor;
    const inside = areas.some(
      (area) =>
        Number(anchor.startColumn) >= area.startColumn &&
        Number(anchor.startRow) >= area.startRow &&
        Number(anchor.endColumn) <= area.endColumn &&
        Number(anchor.endRow) <= area.endRow
    );
    if (inside) continue;
    // A sheet fitted to one page wide exports whole with or without a print
    // area; a declared print area that leaves the drawing out cuts it.
    if (!areas.length && Number(pageSetup.fitToPagesWide) === 1) continue;
    issues.push(
      issue(
        'drawing_outside_print_area',
        entry.path || sheetPath(sheet),
        areas.length
          ? `${kind} spans ${anchor.from}:${anchor.to}, past the print area ${pageSetup.printArea}; a print or PDF export cuts it.`
          : `${kind} spans ${anchor.from}:${anchor.to} and the sheet declares no print area or one-page-wide fit, so an export may paginate through it.`,
        'format-review',
        areas.length ? 'warning' : 'info'
      )
    );
  }
}

// Two drawings on one cell block hide each other: a second chart anchored
// inside the first one's rows prints as one chart drawn over another.
function reviewXlsxDrawingOverlap(sheet, drawings, issues) {
  for (let first = 0; first < drawings.length; first += 1) {
    for (let second = first + 1; second < drawings.length; second += 1) {
      const left = drawings[first].entry.anchor;
      const right = drawings[second].entry.anchor;
      const columns =
        Math.min(Number(left.endColumn), Number(right.endColumn)) -
        Math.max(Number(left.startColumn), Number(right.startColumn));
      const rows =
        Math.min(Number(left.endRow), Number(right.endRow)) - Math.max(Number(left.startRow), Number(right.startRow));
      if (columns < 1 || rows < 1) continue;
      issues.push(
        issue(
          'drawing_overlap',
          drawings[second].entry.path || sheetPath(sheet),
          `${drawings[second].kind} spans ${right.from}:${right.to}, over the ${drawings[first].kind.toLowerCase()} at ${left.from}:${left.to}; place it below or beside it.`,
          'format-review',
          'warning'
        )
      );
    }
  }
}

// A chart or picture laid over filled cells hides them: the figures stay in the file while the page shows the drawing
// on top of them. A 220 pt chart anchored at A8 reached row 22 and covered the block of cells written there.
function reviewXlsxDrawingCover(sheet, cells, drawings, issues) {
  // A formula shows its result whether or not the result is cached yet.
  const filled = cells.filter((cell) => cell?.formula || String(cell?.value ?? '').trim() !== '');
  for (const { kind, entry } of drawings) {
    const anchor = entry.anchor;
    const under = filled.filter((cell) => {
      const row = cellRow(cell.ref);
      const column = cellColumn(cell.ref);
      return (
        row >= Number(anchor.startRow) &&
        row <= Number(anchor.endRow) &&
        column >= Number(anchor.startColumn) &&
        column <= Number(anchor.endColumn)
      );
    });
    if (!under.length) continue;
    const shown = `${under
      .slice(0, 3)
      .map((cell) => cell.ref)
      .join(', ')}${under.length > 3 ? ', …' : ''}`;
    issues.push(
      issue(
        'drawing_covers_cells',
        entry.path || sheetPath(sheet),
        `${kind} spans ${anchor.from}:${anchor.to} over ${under.length} filled cell${under.length === 1 ? '' : 's'} (${shown}) and hides ${under.length === 1 ? 'it' : 'them'}; move it clear with set_drawing, or move the cells.`,
        'format-review',
        'warning'
      )
    );
  }
}

const isFigure = (cell) => typeof cell?.value === 'number' && cell.dataType !== 'text';

// A total row reads as a total only when it is set apart from the rows it sums: its label is bold (the report recipe
// sets the whole row bold over a rule).
function reviewXlsxTotalRows(sheet, cells, totals, issues) {
  for (const row of totals) {
    const label = cells.find(
      (cell) =>
        cellRow(cell.ref) === row &&
        /^(?:grand\s+total|sub\s*total|total|합계|총계|소계)/i.test(String(cell.value || '').trim())
    );
    if (!label || cells.some((cell) => cellRow(cell.ref) === row && cell.style?.bold === true)) continue;
    issues.push(
      issue(
        'total_row_unmarked',
        `/sheet[${sheet.name}]/cell[${label.ref}]`,
        `The "${String(label.value).trim()}" row is set like the rows it sums; set it bold with a rule above (set_style bold, borders.top).`
      )
    );
  }
}

// A column of figures stands on its right edge; a bold header over it set left (Excel's default for text) reads as
// belonging to the column beside it — "월" over 2026-06 sat a column-width away from its dates.
function reviewXlsxHeaderAlignment(sheet, cells, issues) {
  const byRef = new Map(cells.map((cell) => [cell.ref, cell]));
  for (const header of cells) {
    if (header.style?.bold !== true || typeof header.value !== 'string' || !header.value.trim()) continue;
    const match = /^([A-Z]+)(\d+)$/.exec(header.ref);
    if (!match) continue;
    const below = [1, 2].map((offset) => byRef.get(`${match[1]}${Number(match[2]) + offset}`));
    if (!below.every(isFigure)) continue;
    const figureAlignment = below.map((cell) => cell.style?.horizontalAlignment || 'general');
    if (figureAlignment.some((alignment) => !['general', 'right'].includes(alignment))) continue;
    const alignment = header.style?.horizontalAlignment || 'general';
    if (alignment === 'right') continue;
    issues.push(
      issue(
        'header_alignment_mismatch',
        `/sheet[${sheet.name}]/cell[${header.ref}]`,
        `Header "${header.value.trim().slice(0, 20)}" is set ${alignment === 'general' ? 'left' : alignment} over a column of figures set right; align it right (set_style horizontalAlignment:'right').`
      )
    );
  }
}

export function reviewXlsxStructure(document, auditProfile = '') {
  const issues = [];
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  for (const sheet of sheets) {
    const cells = Array.isArray(sheet.cells) ? sheet.cells : [];
    const pageSetup = sheet.pageSetup || {};
    const drawings = sheetDrawings(sheet);
    reviewXlsxHierarchy(sheet, cells, issues, document?.defaultStyle);
    reviewXlsxFormulaErrors(sheet, cells, issues);
    const totals = xlsxTotalRows(cells);
    reviewXlsxChartRanges(sheet, cells, totals, issues);
    reviewXlsxTotalRows(sheet, cells, totals, issues);
    reviewXlsxHeaderAlignment(sheet, cells, issues);
    reviewXlsxPrintFit(sheet, pageSetup, issues);
    reviewXlsxPrintArea(sheet, pageSetup, drawings, issues);
    reviewXlsxDrawingOverlap(sheet, drawings, issues);
    reviewXlsxDrawingCover(sheet, cells, drawings, issues);
  }
  for (const finding of auditXlsxFormulas(sheets, { auditProfile, definedNames: document?.definedNames })) {
    issues.push(issue(finding.code, finding.path, finding.message, 'format-review', finding.severity));
  }
  return issues;
}
