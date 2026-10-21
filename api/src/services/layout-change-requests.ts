/**
 * Layout change requests (#2609) ride the support desk: a "Form change"
 * support request (nivaro_tasks kind 'support') about the record, so the
 * requester follows it under My requests and the desk sees it with the rest.
 *
 * nivaro_tasks has no column for the layout and field the request is about, so
 * the server appends one plain-words line to the description, written and read
 * only here:  `Form: <name> (#<layout id>) · Field: <label> (<field>)`.
 * The desk reads it as text; the layout editor parses it to file the request
 * under the right form and field.
 */

export const FORM_CHANGE_CATEGORY = 'Form change'
export const FORM_CHANGE_DESCRIPTION =
  'Suggestions about how a record form looks or works, sent from the record page.'

const TRAILER_RE = /\n*Form: (.*) \(#(\d+)\)(?: · Field: (.*) \(([A-Za-z_][A-Za-z0-9_]*)\))?\s*$/

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function formChangeTrailer(
  layout: { id: number; name: string } | null,
  field: { name: string; label: string } | null
): string {
  if (!layout) return ''
  const f = field ? ` · Field: ${oneLine(field.label) || field.name} (${field.name})` : ''
  return `\n\nForm: ${oneLine(layout.name)} (#${layout.id})${f}`
}

export function parseFormChange(description: string | null | undefined): {
  message: string
  layout_id: number | null
  layout_name: string | null
  field: string | null
  field_label: string | null
} {
  const text = description ?? ''
  const m = TRAILER_RE.exec(text)
  if (!m)
    return {
      message: text.trim(),
      layout_id: null,
      layout_name: null,
      field: null,
      field_label: null
    }
  return {
    message: text.slice(0, m.index).trim(),
    layout_id: Number(m[2]),
    layout_name: m[1],
    field: m[4] ?? null,
    field_label: m[3] ?? null
  }
}

/** "Form change: <first line of the message>" — the request's summary. */
export function formChangeTitle(message: string): string {
  const first = oneLine(message.split('\n')[0] ?? '')
  return `Form change: ${first.length > 120 ? `${first.slice(0, 117)}…` : first}`
}
