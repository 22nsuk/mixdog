import { cellRecords, columnLabel, sharedStrings } from './portable-cells.mjs';
import { zipText } from './portable-opc.mjs';
import { resolveCellStyles } from './portable-sheet-styles.mjs';

/**
 * A date serial as a date number format shows it (yyyy, yy, mmmm, mmm, mm, m, dd, d, quoted and escaped literals);
 * null when the format is not a date's. A chart cached a month column formatted m"월" as its serials (46174), and
 * Excel kept that cache.
 */
export function formattedDateText(serial, code) {
  const format = String(code || '').split(';')[0];
  const bare = format.replace(/"[^"]*"|\\./g, '');
  if (!/[yd]|m/i.test(bare) || /[hs0#?]/i.test(bare)) return null;
  const value = Number(serial);
  if (!Number.isFinite(value)) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  let out = '';
  for (let index = 0; index < format.length; ) {
    const rest = format.slice(index);
    const literal = /^"([^"]*)"/.exec(rest) || /^\\(.)/.exec(rest);
    if (literal) {
      out += literal[1];
      index += literal[0].length;
      continue;
    }
    const token = /^(yyyy|yy|mmmm|mmm|mm|m|dd|d)/i.exec(rest)?.[1];
    if (token) {
      const lower = token.toLowerCase();
      out += {
        yyyy: String(year),
        yy: String(year).slice(-2),
        mmmm: months[month - 1],
        mmm: months[month - 1].slice(0, 3),
        mm: String(month).padStart(2, '0'),
        m: String(month),
        dd: String(day).padStart(2, '0'),
        d: String(day),
      }[lower];
      index += token.length;
      continue;
    }
    out += format[index];
    index += 1;
  }
  return out;
}

/**
 * What a cell shows as a label: `label` gives a date-formatted number as its date text and anything else as its
 * value; `dated` gives a dated cell's serial and format, null for any other cell.
 */
export async function sheetCellLabelReader(zip, xml) {
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const grid = new Map(cellRecords(xml, await sharedStrings(zip), { styles }).map((record) => [record.ref, record]));
  const dated = (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    const value = record?.formula ? record.cachedValue : record?.value;
    const format = record?.style?.numberFormat;
    return typeof value === 'number' && format && formattedDateText(value, format) !== null
      ? { serial: value, format }
      : null;
  };
  const label = (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    if (!record) return null;
    const date = dated(column, row);
    if (date) return formattedDateText(date.serial, date.format);
    return record.formula ? record.cachedValue : record.value;
  };
  return { label, dated };
}

// What a cell of the sheet shows, by column and row: a formula's last computed
// result, or a literal's own value. A pivot source and a chart's series both
// read the sheet this way.
export async function sheetCellReader(zip, xml) {
  const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
  return (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    if (!record) return null;
    return record.formula ? record.cachedValue : record.value;
  };
}
