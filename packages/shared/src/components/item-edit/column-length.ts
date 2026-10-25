/**
 * The database column's character limit for a text field — field-config
 * rows carry it as `max_length` (null for (max) and non-text columns). A
 * value past it was only refused by the server as "A value is too long for
 * its field", naming no field, so the input stops there and the save says
 * which field is too long.
 */
export function columnMaxLength(field: { max_length?: number | null }): number | null {
  const n = Number(field.max_length)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The save's message for a value past the column limit, or null. */
export function columnLengthError(
  field: { max_length?: number | null },
  value: unknown,
  label: string
): string | null {
  const max = columnMaxLength(field)
  if (max == null || typeof value !== 'string' || value.length <= max) return null
  return `${label} is too long — ${max.toLocaleString()} characters at most (it has ${value.length.toLocaleString()})`
}
