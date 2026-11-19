import { BOOLEAN_TYPES, NUMBER_TYPES, sheetCellForType } from './import-templates.js'

/**
 * Collection imports: a CSV cell is text, the column it lands in may not be. Before a row is
 * written (and in the preview, so the confirm step shows the same result) every cell mapped to
 * a number or yes/no field is read as that type — with the same reading staged and template
 * imports use (import-templates.ts sheetCellForType / parseSheetNumber), so every import path
 * reads a value the same way.
 *
 * EFP prod 2026-11-19: an 86,575-row warehouse inventory file carried on_hand = "26000.00" for
 * an int column; SQL Server refused every row ("Conversion failed when converting the nvarchar
 * value '0.00' to data type int"). "26000.00" is a whole number and now imports as 26000; a
 * real fraction ("3.5") is a row error in plain words naming the field.
 *
 *   integer / bigInteger   "26000", "26000.00", "1,234", " 42 " → whole number; "3.5" refused
 *   decimal / float        thousands commas and spaces dropped; must read as a number
 *   boolean                true/false, yes/no, 1/0, y/n (any case)
 *   empty text             null for every type above
 *
 * Other types pass through untouched. No database, no metadata reads.
 */

/** A target field as the coercion needs it: its type and the label a person knows it by. */
export interface ImportFieldType {
  type: string
  label: string
}

/** A cell that cannot become its field's type. The message is a plain sentence for the row. */
export class ImportValueError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'ImportValueError'
    this.field = field
  }
}

/** Does the import coerce values for a field of this type? */
export function coercesImportType(type: string | null | undefined): boolean {
  const t = String(type ?? '').toLowerCase()
  return NUMBER_TYPES.has(t) || BOOLEAN_TYPES.has(t)
}

/** How a cell is shown in a row error: trimmed and short. */
function shown(v: unknown): string {
  const s = String(v).trim()
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/**
 * One cell → its field's type. Throws ImportValueError (a plain sentence naming the field's
 * label and the file's value) when it cannot be read as that type.
 */
export function coerceImportValue(value: unknown, field: string, meta: ImportFieldType): unknown {
  const read = sheetCellForType(value, meta.type)
  if (read.problem === undefined) return read.value
  const what =
    read.problem === 'whole'
      ? 'a whole number'
      : read.problem === 'boolean'
        ? 'yes or no (true/false, 1/0)'
        : 'a number'
  throw new ImportValueError(field, `${meta.label} must be ${what} — got ${shown(value)}`)
}

/**
 * Coerce every mapped cell of one row in place (fields absent from `types` are left alone).
 * Throws the first cell's ImportValueError, so the row fails with one sentence.
 */
export function coerceImportRow(
  row: Record<string, unknown>,
  types: ReadonlyMap<string, ImportFieldType>
): void {
  for (const [field, meta] of types) {
    if (!(field in row)) continue
    row[field] = coerceImportValue(row[field], field, meta)
  }
}
