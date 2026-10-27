/**
 * CSV formula injection guard for record exports (security audit 2026-10-27, Low).
 *
 * A cell whose text starts with `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated as a
 * formula by Excel / Sheets / LibreOffice (`=HYPERLINK(...)`, DDE payloads). Such text gets a
 * leading single quote so the spreadsheet shows it as text. Plain numbers (`-12.5`, `+3`,
 * `1e-3`) are left alone — a negative amount must stay a number.
 *
 * Returns the cell TEXT; the caller still applies its own CSV quoting.
 */
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

export function csvFormulaSafe(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  const s = String(value)
  if (!/^[=+\-@\t\r]/.test(s)) return s
  return NUMBER_RE.test(s) ? s : `'${s}`
}
