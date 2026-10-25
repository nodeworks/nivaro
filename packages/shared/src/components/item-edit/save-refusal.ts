// Which field a refused save names, so the form can mark it and move to it.
// Leaf module — no React, unit-tested directly.

type ErrorBody = {
  error?: unknown
  message?: unknown
  field?: unknown
  violations?: Array<{ field?: unknown; message?: unknown }>
}

/** Either client error shape: the SDK puts the parsed body on `err.response`,
 *  an axios-backed client under `err.response.data`. */
function bodyOf(err: unknown): ErrorBody | null {
  const resp = (err as { response?: unknown } | null)?.response
  if (!resp || typeof resp !== 'object') return null
  const data = (resp as { data?: unknown }).data
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as ErrorBody
  return resp as ErrorBody
}

const NESTED = /^([A-Za-z0-9_]+)\[([^\]]*)\]:\s*/
const NOTHING_CHANGED = /\s+—\s+nothing was changed.*$/s

/**
 * The form field a refused write is about: a nested child-row refusal
 * ("workflow_lines[0]: Quantity can not be negative — nothing was changed")
 * names the record's lines field; otherwise the body's own `field` (or first
 * violation) when the form has it. `fields` = the form's field keys.
 */
export function refusedFieldOf(
  err: unknown,
  fields: Set<string>
): { field: string; message: string } | null {
  const body = bodyOf(err)
  if (!body) return null
  const text = String(body.error ?? body.message ?? '')
  const nested = NESTED.exec(text)
  if (nested && fields.has(nested[1])) {
    const reason = text.slice(nested[0].length).replace(NOTHING_CHANGED, '').trim()
    // A created row is named by its position in the set ([0]); a saved row by its id.
    const line = /^\d{1,4}$/.test(nested[2]) ? `Line ${Number(nested[2]) + 1}: ` : ''
    return { field: nested[1], message: `${line}${reason || 'A line was refused'}` }
  }
  const v = Array.isArray(body.violations) ? body.violations[0] : undefined
  const field = typeof body.field === 'string' ? body.field : v?.field
  if (typeof field !== 'string' || !fields.has(field)) return null
  const message = String(v?.message ?? (text.replace(NOTHING_CHANGED, '').trim() || 'Invalid'))
  return { field, message }
}
