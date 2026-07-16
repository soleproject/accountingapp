import 'server-only';

/**
 * CSV cell escaper that BOTH quote-escapes per RFC 4180 AND defuses formula
 * injection (=, +, -, @, tab, CR) by prefixing with a single quote that
 * Excel/Google Sheets/LibreOffice will not execute. Without this, a contact
 * named `=cmd|'/c calc'!A1` exfiltrates data when the bookkeeper opens the
 * exported CSV.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (s.length > 0 && FORMULA_PREFIXES.includes(s[0]!)) {
    s = `'${s}`;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** UTF-8 BOM so Excel-on-Windows reads the file as UTF-8. */
export const CSV_BOM = '﻿';
