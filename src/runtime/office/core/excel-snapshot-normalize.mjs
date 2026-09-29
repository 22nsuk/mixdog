import { normalizeExcelCellStyle } from '../portable/portable-sheet-styles.mjs';

// Excel's cells read like the portable snapshot's: RRGGBB colors with
// defaults omitted, and text cells flagged, so the formula audit and the
// model see one shape from both readers.
// Excel names a validation's and a conditional format's kind and operator by enumeration number (3 for a list, 2 for
// an expression) and reads its formulas with a leading "="; the portable reader names them as the file does. One
// shape from both: the OOXML word, the ranges as a list, the formulas without "=", a list literal in its quotes.
const EXCEL_VALIDATION_TYPES = ['none', 'whole', 'decimal', 'list', 'date', 'time', 'textLength', 'custom'];
const EXCEL_OPERATORS = [
  '',
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
];
const EXCEL_CONDITION_TYPES = {
  1: 'cellIs',
  2: 'expression',
  3: 'colorScale',
  4: 'dataBar',
  5: 'top10',
  6: 'iconSet',
  8: 'uniqueValues',
  9: 'containsText',
  10: 'containsBlanks',
  11: 'timePeriod',
  12: 'aboveAverage',
  13: 'notContainsBlanks',
  16: 'containsErrors',
  17: 'notContainsErrors',
};
const withoutEquals = (formula) => String(formula ?? '').replace(/^=/, '');

function normalizeExcelRules(sheet) {
  if (Array.isArray(sheet?.validations)) {
    sheet.validations = sheet.validations.map((entry) => {
      if (!entry || typeof entry.type !== 'number') return entry;
      const type = EXCEL_VALIDATION_TYPES[entry.type] ?? String(entry.type);
      let formula1 = withoutEquals(entry.formula1);
      if (type === 'list' && formula1 && !String(entry.formula1).startsWith('=')) formula1 = `"${formula1}"`;
      return {
        ...entry,
        type,
        operator: type === 'list' || type === 'custom' ? '' : (EXCEL_OPERATORS[entry.operator] ?? ''),
        formula1,
        formula2: withoutEquals(entry.formula2),
      };
    });
  }
  if (Array.isArray(sheet?.conditionalFormats)) {
    sheet.conditionalFormats = sheet.conditionalFormats.map((entry) => {
      if (!entry || typeof entry.type !== 'number') return entry;
      const { range, formula1, formula2, ...rest } = entry;
      const type = EXCEL_CONDITION_TYPES[entry.type] ?? String(entry.type);
      return {
        ...rest,
        ranges: String(range || '')
          .split(/[ ,]+/)
          .filter(Boolean),
        type,
        operator: type === 'cellIs' ? (EXCEL_OPERATORS[entry.operator] ?? '') : '',
        formulas: [formula1, formula2].filter(Boolean).map(withoutEquals),
      };
    });
  }
}

// Excel reports a chart's series as one =SERIES(name, categories, values, order) formula and its kind by number; the
// portable reader splits the three references and names the kind as add_chart does, and the chart audits read them
// split. The arguments are cut at commas outside quotes and parentheses: a quoted sheet name may hold one.
function seriesArguments(formula) {
  const inner = /^=?SERIES\(([\s\S]*)\)$/i.exec(String(formula || '').trim())?.[1];
  if (inner === undefined) return null;
  const parts = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (const character of inner) {
    if (character === "'" || character === '"') quoted = !quoted;
    else if (!quoted && character === '(') depth += 1;
    else if (!quoted && character === ')') depth -= 1;
    if (character === ',' && !quoted && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += character;
  }
  parts.push(current.trim());
  return parts;
}

const EXCEL_CHART_KINDS = {
  51: 'column',
  52: 'stacked_column',
  57: 'bar',
  58: 'stacked_bar',
  4: 'line',
  65: 'line',
  1: 'area',
  5: 'pie',
  '-4120': 'doughnut',
  '-4169': 'scatter',
};

function normalizeExcelCharts(sheet) {
  if (!Array.isArray(sheet?.charts)) return;
  sheet.charts = sheet.charts.map((chart) => {
    if (!chart || typeof chart !== 'object') return chart;
    const next = { ...chart };
    if (typeof next.chartType === 'number' && EXCEL_CHART_KINDS[next.chartType])
      next.chartType = EXCEL_CHART_KINDS[next.chartType];
    if (Array.isArray(next.series)) {
      next.series = next.series.map((series) => {
        const parts = seriesArguments(series?.formula);
        if (!parts) return series;
        const [name = '', categories = '', values = ''] = parts;
        const reference = (text) => (/^'?[^'"]*'?!\$?[A-Z]/i.test(text) ? text : '');
        return {
          ...series,
          formula: reference(name),
          categoryFormula: categories,
          valueFormula: values,
        };
      });
      next.seriesCount = next.series.length;
    }
    // The frame's place is the anchor's; the same four numbers beside it repeat it.
    if (next.anchor && ['left', 'top', 'width', 'height'].every((key) => next[key] === next.anchor[key])) {
      for (const key of ['left', 'top', 'width', 'height']) delete next[key];
    }
    return next;
  });
}

export function normalizeExcelSnapshotStyles(document) {
  for (const sheet of document?.sheets || []) {
    normalizeExcelRules(sheet);
    normalizeExcelCharts(sheet);
    for (const cell of sheet?.cells || []) {
      if (!cell || typeof cell !== 'object') continue;
      if (cell.style) cell.style = normalizeExcelCellStyle(cell.style);
      if (!cell.formula && typeof cell.value === 'string' && cell.value !== '') cell.dataType = 'text';
    }
  }
}
