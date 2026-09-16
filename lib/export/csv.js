'use strict';

/**
 * The one CSV writer for studio exports. RFC 4180: a cell is quoted when it
 * holds a comma, quote, CR or LF, and quotes inside are doubled; rows end in
 * CRLF. The file starts with a UTF-8 BOM so Excel reads `Español` as UTF-8
 * rather than as the system code page — Sheets and every parser ignore it.
 *
 * Numbers are written raw and unrounded: a spreadsheet can format, but it
 * cannot un-round, and Pacifica sums these across stations.
 *
 * Text cells that begin with = + - @ (or a tab/CR) are prefixed with `'`.
 * Excel runs such cells as formulas, and show titles are upstream data — the
 * studio's client-side table CSV (public/studio.js) does the same, for the
 * same reason. Only strings: a negative number is a number, not a formula.
 */
const BOM = '﻿';

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`non-finite number in CSV: ${v}`);
    return String(v);
  }
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** `columns` is the header, in order; each row is an object keyed by column. */
function toCsv(columns, rows) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, BOM };
