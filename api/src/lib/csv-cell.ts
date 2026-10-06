/**
 * One CSV cell, safe to open in a spreadsheet.
 *
 * - Every cell is quoted (RFC 4180), embedded quotes doubled — a value can
 *   never break out of its cell or row.
 * - A value whose first character is `=`, `+`, `-`, `@`, a tab or a carriage
 *   return gets a leading single quote, so Excel / Sheets / LibreOffice show
 *   it as text instead of evaluating it as a formula (CSV formula injection:
 *   route paths, operation names and other caller-supplied text land in these
 *   files and are opened by admins).
 */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

/** A CSV line from cells. */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}
